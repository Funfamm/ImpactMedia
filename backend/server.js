/**
 * AI Impact Media Studio backend
 * - processCastingSubmission
 * - processSponsorInquiry
 * - trackAnalyticsEvent (SQLite)
 * - getQuickStats (SQLite)
 * - getServerConfig
 * - testConnection
 *
 * Files: local uploads folder (see UPLOADS_ROOT)
 * Analytics: SQLite db/analytics.db (table: analytics_events)
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');

// ---------- CONFIG ----------
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

const UPLOADS_ROOT = path.resolve(
  __dirname,
  process.env.UPLOADS_ROOT || LOCAL_CONFIG.UPLOADS_ROOT || '../uploads'
);
if (!fs.existsSync(UPLOADS_ROOT)) fs.mkdirSync(UPLOADS_ROOT, { recursive: true });

// Analytics DB
const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);
const DB_PATH = path.join(DB_DIR, 'analytics.db');
const db = new sqlite3.Database(DB_PATH);

// Create table equivalent to GAS sheet
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      category TEXT,
      action TEXT,
      label TEXT,
      userAgent TEXT,
      page TEXT,
      sessionId TEXT,
      ipAddress TEXT
    )`
  );
});

// Original config equivalents
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

// Session cache (replacement for GAS CacheService)
const sessionCache = new Map();

// ---------- EMAIL ----------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || LOCAL_CONFIG.SMTP_HOST || 'smtp.example.com',
  port: Number(process.env.SMTP_PORT || LOCAL_CONFIG.SMTP_PORT || 587),
  secure: (process.env.SMTP_SECURE || LOCAL_CONFIG.SMTP_SECURE) === 'true',
  auth: {
    user: process.env.SMTP_USER || LOCAL_CONFIG.SMTP_USER || 'user@example.com',
    pass: process.env.SMTP_PASS || LOCAL_CONFIG.SMTP_PASS || 'password'
  }
});

// ---------- EXPRESS ----------
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(morgan('dev'));
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: false
  })
);

// Serve uploads if you want to expose them
app.use('/uploads', express.static(UPLOADS_ROOT));

// ---------- UTILITIES ----------
function getSessionId(userAgent) {
  const uaKey = (userAgent || 'unknown').substring(0, 50);
  const hour = new Date().getHours();
  const key = `session_${uaKey}_${hour}`;
  if (sessionCache.has(key)) return sessionCache.get(key);
  const id = uuidv4();
  sessionCache.set(key, id);
  setTimeout(() => sessionCache.delete(key), 3600 * 1000);
  return id;
}

function getClientIP(req) {
  return (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
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
  if (fileObj.data && Buffer.byteLength(fileObj.data.split(',').pop(), 'base64') > SERVER_CONFIG.maxAudioSize) {
    throw new Error('Audio file too large. Maximum size is 10MB.');
  }
  return true;
}

function validateImageFiles(images) {
  if (!images || images.length === 0) return true;
  if (images.length > SERVER_CONFIG.maxImages) {
    throw new Error(`Too many images. Maximum ${SERVER_CONFIG.maxImages} allowed.`);
  }
  images.forEach((img, i) => {
    if (!img.mimeType || !img.mimeType.startsWith('image/')) {
      throw new Error(`File ${i + 1} is not a valid image.`);
    }
    if (img.data && Buffer.byteLength(img.data.split(',').pop(), 'base64') > SERVER_CONFIG.maxImageSize) {
      throw new Error(`Image ${i + 1} is too large. Maximum size is 5MB.`);
    }
  });
  return true;
}

function saveBase64File(fileObj, folderPath, filename) {
  if (!fileObj.data) {
    throw new Error('No file data provided');
  }
  let base64Data = fileObj.data;
  if (base64Data.includes(',')) base64Data = base64Data.split(',')[1];
  base64Data = base64Data.replace(/\s/g, '');
  if (!base64Data || base64Data.length < 100) {
    throw new Error('File data appears to be empty or too small');
  }

  if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

  const buffer = Buffer.from(base64Data, 'base64');
  const filePath = path.join(folderPath, filename);
  fs.writeFileSync(filePath, buffer);

  const meta = `Submitted: ${new Date().toISOString()}
Original: ${fileObj.name}
Type: ${fileObj.mimeType}
Size: ${buffer.length} bytes
`;
  fs.writeFileSync(filePath + '.meta.txt', meta);

  // TODO: replace url with cloud storage URL if you move off local FS
  return { filePath, url: `/uploads/${encodeURIComponent(path.basename(folderPath))}/${encodeURIComponent(filename)}` };
}

function processFilesInNode(formData, subFolderName) {
  const safe = (subFolderName || 'Applicant')
    .replace(/[^\w\s-]/g, '')
    .substring(0, 200) || 'Applicant';
  const folder = path.join(UPLOADS_ROOT, safe);
  const fileLinks = [];

  if (formData.images && formData.images.length > 0) {
    formData.images.forEach((img, i) => {
      if (!img || !img.data) return;
      try {
        const ext = getFileExtension(img.mimeType) || 'jpg';
        const fname = `Photo_${i + 1}.${ext}`;
        const saved = saveBase64File(img, folder, fname);
        fileLinks.push(`Photo ${i + 1}: ${saved.url}`);
      } catch (e) {
        console.error('Image save failed', e);
      }
    });
  }

  if (formData.voice && formData.voice.data) {
    try {
      const fname = 'VoiceSample.mp3';
      const saved = saveBase64File(formData.voice, folder, fname);
      fileLinks.push(`Voice Sample: ${saved.url}`);
    } catch (e) {
      console.error('Audio save failed', e);
    }
  }

  return fileLinks;
}

function countByCategory(rows, category, action, label = '') {
  let count = 0;
  for (const r of rows) {
    if (
      r.category === category &&
      r.action === action &&
      (!label || r.label === label)
    ) {
      count++;
    }
  }
  return count;
}

// ---------- EMAIL HELPERS ----------
async function sendSubmissionEmails(formObject, subFolderName, filesProcessed, fileLinks) {
  const adminSubject = `NEW CASTING SUBMISSION: ${formObject.name} (${formObject.social || 'No Handle'})`;
  const fileList = fileLinks.length ? fileLinks.join('\n') : 'No files uploaded';
  const adminBody =
    `A new casting submission has been received.\n\n` +
    `Applicant: ${formObject.name}\n` +
    `Email: ${formObject.email}\n` +
    `Social Handle: ${formObject.social || 'Not provided'}\n` +
    `Files Processed: ${filesProcessed}\n` +
    `Folder: ${subFolderName}\n\n` +
    `Files:\n${fileList}`;

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

  await transporter.sendMail({
    from: `"${SENDER_NAME}" <${RECIPIENT_EMAIL}>`,
    to: RECIPIENT_EMAIL,
    subject: adminSubject,
    text: adminBody
  });

  await transporter.sendMail({
    from: `"${SENDER_NAME}" <${RECIPIENT_EMAIL}>`,
    to: formObject.email,
    subject: userSubject,
    text: userBody
  });
}

async function sendSponsorEmail(formData) {
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
}

// ---------- CORE LOGIC ----------
async function processCastingSubmission(formObject) {
  const required = ['email', 'name', 'agree_voluntary', 'agree_usage', 'agree_data'];
  for (const f of required) {
    if (!formObject[f]) throw new Error(`Required field missing: ${f}`);
  }
  if (formObject.images && formObject.images.length) {
    validateImageFiles(formObject.images);
  }
  if (formObject.voice && formObject.voice.data) {
    validateAudioFile(formObject.voice);
  }

  const ts = new Date()
    .toISOString()
    .replace(/[:]/g, '-')
    .replace(/\..+$/, '');
  let subFolder = formObject.social || `Applicant_${formObject.name}`;
  subFolder = `${subFolder}_${ts}`;

  const fileLinks = processFilesInNode(formObject, subFolder);
  const filesProcessed = fileLinks.length;

  try {
    await sendSubmissionEmails(formObject, subFolder, filesProcessed, fileLinks);
  } catch (e) {
    console.error('Email error (non-critical):', e);
  }

  const msg = formObject.voice
    ? `SUCCESS: Your application with MP3 voice sample has been submitted! Processed ${filesProcessed} file(s). Confirmation sent to ${formObject.email}.`
    : `SUCCESS: Your application has been submitted! Processed ${filesProcessed} file(s). Confirmation sent to ${formObject.email}.`;

  return { success: true, message: msg, filesProcessed, fileLinks };
}

async function processSponsorInquiry(formData) {
  if (!formData.contactEmail) throw new Error('Contact email is required.');
  await sendSponsorEmail(formData);
  return {
    success: true,
    message: "SUCCESS: Your sponsorship inquiry has been sent. We'll contact you shortly."
  };
}

function trackAnalyticsEvent(eventData, req) {
  return new Promise((resolve, reject) => {
    const timestamp = new Date().toISOString();
    const userAgent = eventData.userAgent || req.headers['user-agent'] || 'unknown';
    const page = eventData.page || '/';
    const sessionId = getSessionId(userAgent);
    const ipAddress = getClientIP(req);

    const stmt = db.prepare(
      `INSERT INTO analytics_events
        (timestamp, category, action, label, userAgent, page, sessionId, ipAddress)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      timestamp,
      eventData.category || '',
      eventData.action || '',
      eventData.label || '',
      userAgent,
      page,
      sessionId,
      ipAddress,
      (err) => {
        stmt.finalize();
        if (err) return reject(err);
        resolve({ success: true, message: 'Event tracked' });
      }
    );
  });
}

function getQuickStats() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM analytics_events ORDER BY id DESC LIMIT 100`,
      (err, rows) => {
        if (err) return reject(err);
        if (!rows || !rows.length) {
          return resolve({
            totalEvents: 0,
            uniqueSessions: 0,
            pageViews: 0,
            donationClicks: 0,
            formSubmissions: 0,
            lastUpdated: new Date().toISOString()
          });
        }
        const totalEvents = rows.length;
        const uniqueSessions = new Set(rows.map((r) => r.sessionId)).size;
        const pageViews = countByCategory(rows, 'Navigation', 'Page View');
        const donationClicks = countByCategory(rows, 'Donation', 'Button Click');
        const formSubmissions = countByCategory(rows, 'Form', 'Submission Success');
        resolve({
          totalEvents,
          uniqueSessions,
          pageViews,
          donationClicks,
          formSubmissions,
          lastUpdated: new Date().toISOString()
        });
      }
    );
  });
}

function getServerConfig() {
  return {
    maxImages: SERVER_CONFIG.maxImages,
    allowedAudioTypes: ALLOWED_AUDIO_TYPES,
    maxAudioSize: SERVER_CONFIG.maxAudioSize,
    maxImageSize: SERVER_CONFIG.maxImageSize,
    serverTime: new Date().toISOString(),
    useCloudFunctions: false
  };
}

function testConnection() {
  return `Server is connected! Current time: ${new Date().toISOString()}`;
}

// ---------- ROUTES ----------

app.get('/api/testConnection', (req, res) => {
  res.json({ status: 'ok', message: testConnection() });
});

app.post('/api/processCastingSubmission', async (req, res) => {
  try {
    const result = await processCastingSubmission(req.body || {});
    res.json(result);
  } catch (e) {
    console.error('Casting error', e);
    res.status(400).json({
      success: false,
      message: `Submission failed: ${e.message || 'Unknown error'}`
    });
  }
});

app.post('/api/processSponsorInquiry', async (req, res) => {
  try {
    const result = await processSponsorInquiry(req.body || {});
    res.json(result);
  } catch (e) {
    console.error('Sponsor error', e);
    res.status(400).json({
      success: false,
      message: `Failed to send inquiry: ${e.message || 'Unknown error'}`
    });
  }
});

app.post('/api/trackAnalyticsEvent', async (req, res) => {
  try {
    const result = await trackAnalyticsEvent(req.body || {}, req);
    res.json(result);
  } catch (e) {
    console.error('Analytics error', e);
    res.status(500).json({
      success: false,
      message: 'Analytics tracking failed'
    });
  }
});

app.get('/api/getQuickStats', async (req, res) => {
  try {
    const stats = await getQuickStats();
    res.json(stats);
  } catch (e) {
    console.error('Stats error', e);
    res.status(500).json({ error: 'Failed to compute stats' });
  }
});

app.get('/api/getServerConfig', (req, res) => {
  res.json(getServerConfig());
});

// Optional: donation tracking hook if you want to mirror trackDonation()
app.post('/api/trackDonation', async (req, res) => {
  try {
    await trackAnalyticsEvent(
      {
        category: 'Donation',
        action: 'Recorded',
        label: req.body.label || ''
      },
      req
    );
    res.json({ success: true, message: 'Donation recorded' });
  } catch (e) {
    console.error('Donation tracking error', e);
    res.status(500).json({ success: false, message: 'Error tracking donation' });
  }
});

app.listen(PORT, () => {
  console.log(`AI Impact Media backend (SQLite) listening on port ${PORT}`);
});
