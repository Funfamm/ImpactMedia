/**
 * Node/Express backend for AI Impact Media Studio
 * Migrated from Google Apps Script (Code.gs).
 * Recreates:
 * - processCastingSubmission
 * - processSponsorInquiry
 * - trackAnalyticsEvent / getQuickStats
 * - getServerConfig
 * - testConnection
 *
 * Storage:
 * - Files: local ./storage/uploads
 * - Analytics: local ./storage/analytics.json
 *
 * Email: nodemailer (configure SMTP via config.json or environment variables).
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

// ---------- CONFIGURATION ----------
const CONFIG_FILE = path.join(__dirname, 'config.json');
let LOCAL_CONFIG = {};
if (fs.existsSync(CONFIG_FILE)) {
  LOCAL_CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

const PORT = process.env.PORT || LOCAL_CONFIG.PORT || 4000;
const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN || LOCAL_CONFIG.FRONTEND_ORIGIN || '*';

const RECIPIENT_EMAIL =
  process.env.ADMIN_EMAIL || LOCAL_CONFIG.ADMIN_EMAIL || 'ai.impactmediastudio@gmail.com';
const SENDER_NAME =
  process.env.SENDER_NAME || LOCAL_CONFIG.SENDER_NAME || 'AI Impact Media Studio Admin';

// Storage paths (local FS instead of Google Drive)
const STORAGE_ROOT = path.join(__dirname, 'storage');
const UPLOADS_ROOT = path.join(STORAGE_ROOT, 'uploads');
const ANALYTICS_FILE = path.join(STORAGE_ROOT, 'analytics.json');

// Ensure storage directories/files exist
if (!fs.existsSync(STORAGE_ROOT)) fs.mkdirSync(STORAGE_ROOT);
if (!fs.existsSync(UPLOADS_ROOT)) fs.mkdirSync(UPLOADS_ROOT);
if (!fs.existsSync(ANALYTICS_FILE)) {
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify([]));
}

// ---- Original GAS constants / configuration ----
const ALLOWED_AUDIO_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-mpeg'
];

const SERVER_CONFIG = {
  analyticsBatchSize: 500,
  dashboardUpdateFrequency: 50,
  maxImages: 6,
  maxAudioSize: 10 * 1024 * 1024,
  maxImageSize: 5 * 1024 * 1024,
  cacheTimeout: 600
};

// Simple in-memory cache/session substitute for GAS CacheService/Session
const sessionCache = new Map();

// ---------- EMAIL TRANSPORT (Nodemailer) ----------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || LOCAL_CONFIG.SMTP_HOST || 'smtp.example.com',
  port: Number(process.env.SMTP_PORT || LOCAL_CONFIG.SMTP_PORT || 587),
  secure: (process.env.SMTP_SECURE || LOCAL_CONFIG.SMTP_SECURE) === 'true',
  auth: {
    user: process.env.SMTP_USER || LOCAL_CONFIG.SMTP_USER || 'user@example.com',
    pass: process.env.SMTP_PASS || LOCAL_CONFIG.SMTP_PASS || 'password'
  }
});

// TODO: In production, verify transporter configuration with transporter.verify()

// ---------- EXPRESS APP SETUP ----------
const app = express();
app.use(express.json({ limit: '25mb' })); // support base64 file payloads
app.use(morgan('dev'));
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: false
  })
);

// ---------- UTILITY FUNCTIONS (GAS equivalents) ----------

function getSessionId(userAgent) {
  const uaKey = (userAgent || 'unknown').substring(0, 50);
  const hour = new Date().getHours();
  const cacheKey = `session_${uaKey}_${hour}`;
  if (sessionCache.has(cacheKey)) {
    return sessionCache.get(cacheKey);
  }
  const sessionId = uuidv4();
  // Cache for 1 hour (in-memory only)
  sessionCache.set(cacheKey, sessionId);
  setTimeout(() => sessionCache.delete(cacheKey), 3600 * 1000);
  return sessionId;
}

function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function getFileExtension(mimeType) {
  const mimeMap = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'mp4'
  };
  return mimeMap[mimeType] || null;
}

function validateAudioFile(fileObj) {
  if (!fileObj || !fileObj.mimeType) {
    throw new Error('Invalid audio file: No MIME type detected');
  }

  const mime = fileObj.mimeType.toLowerCase();
  if (!ALLOWED_AUDIO_TYPES.includes(mime)) {
    throw new Error(
      `Invalid audio format. Only MP3 files are allowed. Detected: ${fileObj.mimeType}`
    );
  }

  if (fileObj.name && !fileObj.name.toLowerCase().endsWith('.mp3')) {
    throw new Error('Invalid file extension. Only .mp3 files are allowed.');
  }

  if (fileObj.data && Buffer.byteLength(fileObj.data, 'base64') > SERVER_CONFIG.maxAudioSize) {
    throw new Error('Audio file too large. Maximum size is 10MB.');
  }

  return true;
}

function validateImageFiles(images) {
  if (!images || images.length === 0) return true;

  if (images.length > SERVER_CONFIG.maxImages) {
    throw new Error(`Too many images. Maximum ${SERVER_CONFIG.maxImages} allowed.`);
  }

  images.forEach((img, index) => {
    if (!img.mimeType || !img.mimeType.startsWith('image/')) {
      throw new Error(`File ${index + 1} is not a valid image.`);
    }

    if (img.data && Buffer.byteLength(img.data, 'base64') > SERVER_CONFIG.maxImageSize) {
      throw new Error(
        `Image ${index + 1} is too large. Maximum size is 5MB.`
      );
    }
  });

  return true;
}

function saveBase64File(fileObj, targetFolder, filename) {
  if (!fileObj.data) {
    throw new Error('No file data provided');
  }

  let base64Data = fileObj.data;
  if (base64Data.includes(',')) {
    base64Data = base64Data.split(',')[1];
  }
  base64Data = base64Data.replace(/\s/g, '');

  if (!base64Data || base64Data.length < 100) {
    throw new Error('File data appears to be empty or too small');
  }

  const buffer = Buffer.from(base64Data, 'base64');
  const filePath = path.join(targetFolder, filename);
  fs.writeFileSync(filePath, buffer);

  // In GAS this sets description and metadata; here we can store a small sidecar .txt if desired.
  const meta = `Submitted: ${new Date().toISOString()}\nOriginal: ${fileObj.name}\nType: ${fileObj.mimeType}\nSize: ${buffer.length} bytes\n`;
  fs.writeFileSync(filePath + '.meta.txt', meta);

  // Return a pseudo URL (adjust when serving files statically or via CDN)
  // TODO: Replace with real public URL if using cloud storage.
  return {
    path: filePath,
    url: `/uploads/${encodeURIComponent(filename)}`
  };
}

function processFilesInNode(formData, subFolderName) {
  const safeName = subFolderName.replace(/[^\w\s-]/g, '').substring(0, 200) || 'Applicant';
  const folderPath = path.join(UPLOADS_ROOT, safeName);
  if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

  const fileLinks = [];

  // Images
  if (formData.images && formData.images.length > 0) {
    formData.images.forEach((imgObj, index) => {
      if (imgObj && imgObj.data) {
        try {
          const ext = getFileExtension(imgObj.mimeType) || 'jpg';
          const filename = `Photo_${index + 1}.${ext}`;
          const saved = saveBase64File(imgObj, folderPath, filename);
          fileLinks.push(`Photo ${index + 1}: ${saved.url}`);
        } catch (e) {
          // Log and continue
          console.error(`Failed to save image ${index}:`, e.toString());
        }
      }
    });
  }

  // Voice
  if (formData.voice && formData.voice.data) {
    try {
      const filename = 'VoiceSample.mp3';
      const saved = saveBase64File(formData.voice, folderPath, filename);
      fileLinks.push(`Voice Sample: ${saved.url}`);
    } catch (e) {
      console.error('Failed to save audio:', e.toString());
    }
  }

  return fileLinks;
}

// In Apps Script, this prefers Cloud Functions and falls back locally.
// Here we just call the local implementation.
// TODO: Plug in cloud storage / worker if needed.
function processFilesWithCloudEquivalent(formData, subFolderName) {
  return processFilesInNode(formData, subFolderName);
}

// ---------- ANALYTICS STORAGE HELPERS ----------

function readAnalytics() {
  const raw = fs.readFileSync(ANALYTICS_FILE, 'utf8');
  try {
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

function writeAnalytics(rows) {
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(rows, null, 2));
}

function countByCategoryOptimized(data, category, action, label = '') {
  let count = 0;
  for (const row of data) {
    if (
      row.category === category &&
      row.action === action &&
      (!label || row.label === label)
    ) {
      count++;
    }
  }
  return count;
}

function getQuickStatsLocal() {
  const data = readAnalytics();
  if (!data.length) {
    return {
      totalEvents: 0,
      uniqueSessions: 0,
      pageViews: 0,
      donationClicks: 0,
      formSubmissions: 0,
      lastUpdated: new Date().toISOString()
    };
  }

  const lastRows = data.slice(-100);
  const totalEvents = lastRows.length;
  const uniqueSessions = new Set(lastRows.map(r => r.sessionId)).size;
  const pageViews = countByCategoryOptimized(lastRows, 'Navigation', 'Page View');
  const donationClicks = countByCategoryOptimized(
    lastRows,
    'Donation',
    'Button Click'
  );
  const formSubmissions = countByCategoryOptimized(
    lastRows,
    'Form',
    'Submission Success'
  );

  return {
    totalEvents,
    uniqueSessions,
    pageViews,
    donationClicks,
    formSubmissions,
    lastUpdated: new Date().toISOString()
  };
}

// ---------- EMAIL HELPERS (GAS MailApp equivalents) ----------

async function sendSubmissionEmails(formObject, subFolderName, filesProcessed, fileLinks) {
  const adminSubject = `NEW CASTING SUBMISSION: ${formObject.name} (${formObject.social || 'No Handle'})`;
  const fileListString = fileLinks.length > 0 ? fileLinks.join('\n') : 'No files uploaded';

  const adminBody =
    `A new casting submission has been received.\n\n` +
    `Applicant: ${formObject.name}\n` +
    `Email: ${formObject.email}\n` +
    `Social Handle: ${formObject.social || 'Not provided'}\n` +
    `Files Processed: ${filesProcessed}\n` +
    `Folder: ${subFolderName}\n\n` +
    `Files:\n${fileListString}`;

  const userSubject = 'AI Impact Media Studio - Casting Submission Received';
  const userFileInfo = formObject.voice
    ? `We've received your ${filesProcessed} file(s) including your MP3 voice sample.`
    : `We've received your ${filesProcessed} file(s).`;

  const userBody =
    `Dear ${formObject.name},\n\n` +
    `Thank you for submitting your casting application to AI Impact Media Studio.\n\n` +
    `${userFileInfo}\n\n` +
    `Your application has been archived in our secure database.\n\n` +
    `If your profile matches our upcoming AI-generated projects, our team will contact you via the email you provided.\n\n` +
    `Best regards,\nAI Impact Media Studio Team\n${RECIPIENT_EMAIL}`;

  // Admin email
  await transporter.sendMail({
    from: `"${SENDER_NAME}" <${RECIPIENT_EMAIL}>`,
    to: RECIPIENT_EMAIL,
    subject: adminSubject,
    text: adminBody
  });

  // User confirmation
  await transporter.sendMail({
    from: `"${SENDER_NAME}" <${RECIPIENT_EMAIL}>`,
    to: formObject.email,
    subject: userSubject,
    text: userBody
  });
}

// ---------- CORE BUSINESS LOGIC (GAS parity) ----------

async function processCastingSubmission(formObject) {
  // Validation
  const requiredFields = ['email', 'name', 'agree_voluntary', 'agree_usage', 'agree_data'];
  for (const field of requiredFields) {
    if (!formObject[field]) {
      throw new Error(`Required field missing: ${field}`);
    }
  }

  // Validate files
  if (formObject.images && formObject.images.length > 0) {
    validateImageFiles(formObject.images);
  }
  if (formObject.voice && formObject.voice.data) {
    validateAudioFile(formObject.voice);
  }

  // Subfolder name
  const timeStamp = new Date()
    .toISOString()
    .replace(/[:]/g, '-')
    .replace(/\..+$/, '');
  let subFolderName = formObject.social ? formObject.social : `Applicant_${formObject.name}`;
  subFolderName = `${subFolderName}_${timeStamp}`;

  // Files
  const fileLinks = processFilesWithCloudEquivalent(formObject, subFolderName);
  const filesProcessed = fileLinks.length;

  // Emails (do not block errors)
  try {
    await sendSubmissionEmails(formObject, subFolderName, filesProcessed, fileLinks);
  } catch (e) {
    console.error('Email error (non-critical):', e.toString());
  }

  const message = formObject.voice
    ? `SUCCESS: Your application with MP3 voice sample has been submitted! Processed ${filesProcessed} file(s). Confirmation sent to ${formObject.email}.`
    : `SUCCESS: Your application has been submitted! Processed ${filesProcessed} file(s). Confirmation sent to ${formObject.email}.`;

  return {
    success: true,
    message,
    filesProcessed,
    fileLinks
  };
}

async function processSponsorInquiry(formData) {
  if (!formData.contactEmail) {
    throw new Error('Contact email is required.');
  }

  const subject = `SPONSORSHIP INQUIRY: ${formData.company}`;
  const body =
    `New sponsorship inquiry received:\n\n` +
    `Company: ${formData.company}\n` +
    `Contact: ${formData.contactName}\n` +
    `Email: ${formData.contactEmail}\n\n` +
    `Message:\n${formData.message || 'No message provided'}`;

  await transporter.sendMail({
    from: `"${SENDER_NAME}" <${RECIPIENT_EMAIL}>`,
    to: RECIPIENT_EMAIL,
    subject,
    text: body,
    replyTo: formData.contactEmail
  });

  return {
    success: true,
    message: "SUCCESS: Your sponsorship inquiry has been sent. We'll contact you shortly."
  };
}

function trackAnalyticsEvent(eventData, req) {
  const rows = readAnalytics();

  const timestamp = new Date().toISOString();
  const userAgent = eventData.userAgent || req.headers['user-agent'] || 'unknown';
  const page = eventData.page || '/';
  const sessionId = getSessionId(userAgent);
  const ipAddress = getClientIP(req);

  const row = {
    timestamp,
    category: eventData.category,
    action: eventData.action,
    label: eventData.label || '',
    userAgent,
    page,
    sessionId,
    ipAddress
  };

  rows.push(row);
  writeAnalytics(rows);

  return { success: true, message: 'Event tracked' };
}

function getServerConfig() {
  return {
    maxImages: SERVER_CONFIG.maxImages,
    allowedAudioTypes: ALLOWED_AUDIO_TYPES,
    maxAudioSize: SERVER_CONFIG.maxAudioSize,
    maxImageSize: SERVER_CONFIG.maxImageSize,
    serverTime: new Date().toISOString(),
    useCloudFunctions: false // no Cloud Functions in Node version
  };
}

function testConnection() {
  return `Server is connected! Current time: ${new Date().toISOString()}`;
}

// ---------- EXPRESS ROUTES (HTTP endpoints) ----------

// Health check / testConnection
app.get('/api/testConnection', (req, res) => {
  res.json({ status: 'ok', message: testConnection() });
});

// Casting submission
app.post('/api/processCastingSubmission', async (req, res) => {
  try {
    const formObject = req.body || {};
    const result = await processCastingSubmission(formObject);
    res.json(result);
  } catch (err) {
    console.error('Submission error:', err.toString());
    res.status(400).json({
      success: false,
      message: `Submission failed: ${err.message || 'Unknown error'}`
    });
  }
});

// Sponsor inquiry
app.post('/api/processSponsorInquiry', async (req, res) => {
  try {
    const result = await processSponsorInquiry(req.body || {});
    res.json(result);
  } catch (err) {
    console.error('Sponsor inquiry error:', err.toString());
    res.status(400).json({
      success: false,
      message: `Failed to send inquiry: ${err.message || 'Unknown error'}`
    });
  }
});

// Analytics: track event
app.post('/api/trackAnalyticsEvent', (req, res) => {
  try {
    const result = trackAnalyticsEvent(req.body || {}, req);
    res.json(result);
  } catch (err) {
    console.error('Analytics error:', err.toString());
    res.status(500).json({
      success: false,
      message: 'Analytics tracking failed'
    });
  }
});

// Analytics: quick stats
app.get('/api/getQuickStats', (req, res) => {
  try {
    const stats = getQuickStatsLocal();
    res.json(stats);
  } catch (err) {
    console.error('Quick stats error:', err.toString());
    res.status(500).json({ error: 'Failed to compute stats' });
  }
});

// Server config
app.get('/api/getServerConfig', (req, res) => {
  res.json(getServerConfig());
});

// Static serving of uploaded files (optional; restrict in production)
app.use('/uploads', express.static(UPLOADS_ROOT));

// Start server
app.listen(PORT, () => {
  console.log(`AI Impact Media backend listening on port ${PORT}`);
});
