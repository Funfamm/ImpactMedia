// Frontend logic for AI Impact Media Studio
// Replaces google.script.run with fetch() calls to Node/Express backend.

const API_BASE = 'https://your-backend-host.com'; // TODO: set to real backend origin

// ---- DOM helpers ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function setActiveSection(id) {
  $$('.section').forEach((s) => s.classList.remove('active'));
  $(`#section-${id}`).classList.add('active');
  $$('.nav-link').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.section === id);
  });
}

function showMessage(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.classList.toggle('success', !isError && !!text);
}

// ---- Casting form: file handling & submission ----

function previewImages(files) {
  const previewContainer = $('#image-preview');
  previewContainer.innerHTML = '';
  Array.from(files).forEach((file, index) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const div = document.createElement('div');
      div.className = 'preview-item';
      div.innerHTML = `<img src="${e.target.result}" alt="Photo ${index + 1}">
                       <span>${index + 1}</span>`;
      previewContainer.appendChild(div);
    };
    reader.readAsDataURL(file);
  });
}

function handleVoicePreview(file) {
  const audioEl = $('#voice-preview');
  if (!file) {
    audioEl.classList.add('hidden');
    audioEl.removeAttribute('src');
    return;
  }
  const url = URL.createObjectURL(file);
  audioEl.src = url;
  audioEl.classList.remove('hidden');
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

async function buildCastingPayload() {
  const name = $('#cast-name').value.trim();
  const email = $('#cast-email').value.trim();
  const social = $('#cast-social').value.trim();
  const agreeVol = $('#agree-voluntary').checked;
  const agreeUsage = $('#agree-usage').checked;
  const agreeData = $('#agree-data').checked;

  const imagesInput = $('#cast-images');
  const voiceInput = $('#cast-voice');

  const images = [];
  if (imagesInput.files.length) {
    for (const file of imagesInput.files) {
      const dataUrl = await readFileAsBase64(file);
      images.push({
        name: file.name,
        mimeType: file.type,
        data: dataUrl
      });
    }
  }

  let voice = null;
  if (voiceInput.files[0]) {
    const file = voiceInput.files[0];
    const dataUrl = await readFileAsBase64(file);
    voice = {
      name: file.name,
      mimeType: file.type || 'audio/mpeg',
      data: dataUrl
    };
  }

  return {
    name,
    email,
    social,
    agree_voluntary: agreeVol,
    agree_usage: agreeUsage,
    agree_data: agreeData,
    images,
    voice
  };
}

async function submitCastingForm(evt) {
  evt.preventDefault();
  const msgEl = $('#casting-message');
  showMessage(msgEl, '');
  $('#casting-loading').classList.remove('hidden');
  $('#casting-submit').disabled = true;

  try {
    const payload = await buildCastingPayload();

    // Basic client-side validation mirroring required fields
    if (!payload.name || !payload.email || !payload.agree_voluntary || !payload.agree_usage || !payload.agree_data) {
      throw new Error('Please complete all required fields and agreements.');
    }

    const res = await fetch(`${API_BASE}/api/processCastingSubmission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Submission failed.');
    }

    showMessage(msgEl, data.message || 'Submission successful.', false);

    // Track analytics event
    trackAnalytics({
      category: 'Form',
      action: 'Submission Success',
      label: 'Casting Application'
    });

    // Optional: reset form
    $('#casting-form').reset();
    $('#image-preview').innerHTML = '';
    handleVoicePreview(null);
  } catch (err) {
    showMessage(msgEl, err.message || 'Submission failed.', true);
    trackAnalytics({
      category: 'Form',
      action: 'Submission Error',
      label: 'Casting Application'
    });
  } finally {
    $('#casting-loading').classList.add('hidden');
    $('#casting-submit').disabled = false;
  }
}

// ---- Sponsorship form ----

async function submitSponsorForm(evt) {
  evt.preventDefault();
  const msgEl = $('#sponsor-message-box');
  showMessage(msgEl, '');
  $('#sponsor-loading').classList.remove('hidden');
  $('#sponsor-submit').disabled = true;

  try {
    const payload = {
      company: $('#sponsor-company').value.trim(),
      contactName: $('#sponsor-contact-name').value.trim(),
      contactEmail: $('#sponsor-contact-email').value.trim(),
      message: $('#sponsor-message').value.trim()
    };

    if (!payload.contactEmail) {
      throw new Error('Contact email is required.');
    }

    const res = await fetch(`${API_BASE}/api/processSponsorInquiry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Failed to send inquiry.');
    }

    showMessage(msgEl, data.message, false);

    trackAnalytics({
      category: 'Form',
      action: 'Submission Success',
      label: 'Sponsor Inquiry'
    });

    $('#sponsor-form').reset();
  } catch (err) {
    showMessage(msgEl, err.message || 'Failed to send inquiry.', true);
    trackAnalytics({
      category: 'Form',
      action: 'Submission Error',
      label: 'Sponsor Inquiry'
    });
  } finally {
    $('#sponsor-loading').classList.add('hidden');
    $('#sponsor-submit').disabled = false;
  }
}

// ---- Analytics tracking & quick stats ----

async function trackAnalytics({ category, action, label }) {
  try {
    const payload = {
      category,
      action,
      label,
      userAgent: navigator.userAgent,
      page: location.pathname + location.search
    };
    await fetch(`${API_BASE}/api/trackAnalyticsEvent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch {
    // Silent fail; analytics must not break UX
  }
}

async function loadQuickStats() {
  $('#stats-loading').classList.remove('hidden');
  $('#stats-error').textContent = '';
  try {
    const res = await fetch(`${API_BASE}/api/getQuickStats`);
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Failed to load stats.');
    }
    $('#stat-totalEvents').textContent = data.totalEvents ?? 0;
    $('#stat-uniqueSessions').textContent = data.uniqueSessions ?? 0;
    $('#stat-pageViews').textContent = data.pageViews ?? 0;
    $('#stat-donationClicks').textContent = data.donationClicks ?? 0;
    $('#stat-formSubmissions').textContent = data.formSubmissions ?? 0;
    $('#stat-lastUpdated').textContent = data.lastUpdated
      ? new Date(data.lastUpdated).toLocaleString()
      : '–';
  } catch (err) {
    $('#stats-error').textContent = err.message || 'Failed to load stats.';
  } finally {
    $('#stats-loading').classList.add('hidden');
  }
}

// ---- Navigation & bootstrapping ----

function initNav() {
  $$('.nav-link').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.section;
      setActiveSection(id);
      trackAnalytics({
        category: 'Navigation',
        action: 'Page View',
        label: id
      });
    });
  });
}

function initForms() {
  $('#casting-form').addEventListener('submit', submitCastingForm);
  $('#sponsor-form').addEventListener('submit', submitSponsorForm);

  $('#cast-images').addEventListener('change', (e) => {
    previewImages(e.target.files);
  });

  $('#cast-voice').addEventListener('change', (e) => {
    handleVoicePreview(e.target.files[0]);
  });
}

function initMisc() {
  $('#year').textContent = new Date().getFullYear();
  $('#refresh-stats').addEventListener('click', loadQuickStats);

  // Initial analytics event
  trackAnalytics({
    category: 'Navigation',
    action: 'Page View',
    label: 'landing'
  });

  // Optionally pre-load server config (validation hints)
  // fetch(`${API_BASE}/api/getServerConfig`).then(...);
}

document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initForms();
  initMisc();
});
