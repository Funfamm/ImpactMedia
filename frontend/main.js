const API_BASE = 'https://your-backend-domain.com'; // set your backend API origin here

// ... other code unchanged ...

async function submitSponsorForm(evt) {
  evt.preventDefault();
  const msgEl = $('#sponsor-message-box');
  showMessage(msgEl, '');
  $('#sponsor-loading').classList.remove('hidden');
  $('#sponsor-submit').disabled = true;

  try {
    const formData = {
      company: $('#sponsor-company').value.trim(),
      contactName: $('#sponsor-contact-name').value.trim(),
      contactEmail: $('#sponsor-contact-email').value.trim(),
      message: $('#sponsor-message').value.trim()
    };

    if (!formData.contactEmail) {
      throw new Error('Contact email is required.');
    }

    const res = await fetch(`${API_BASE}/api/processSponsorInquiry`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(formData)
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

// General analytics tracking helper function

async function trackAnalytics({ category, action, label = '' }) {
  try {
    await fetch(`${API_BASE}/api/trackAnalyticsEvent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category,
        action,
        label,
        userAgent: navigator.userAgent,
        page: window.location.href
      })
    });
  } catch {
    // Fail silently, do not impact UX
  }
}
