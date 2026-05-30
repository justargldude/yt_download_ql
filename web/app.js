/* ═══════════════════════════════════════════
   YT Highlight Queue — Application Logic
   ═══════════════════════════════════════════ */

// ── Configuration ──────────────────────────
const CONFIG = {
  firebase: {
    apiKey: 'AIzaSyCMgmRAFeMjnBeg0wrHOLo1yuMb657mv08',
    authDomain: 'yt-highlight-queue.firebaseapp.com',
    databaseURL: 'https://yt-highlight-queue-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'yt-highlight-queue',
    storageBucket: 'yt-highlight-queue.firebasestorage.app',
    messagingSenderId: '270809931102',
    appId: '1:270809931102:web:4d2ccbd54c967e83e143cf'
  },
  telegram: {
    botToken: '8540195843:AAHBgsJ3U3oY3blgyOG9ZTXn9Rz9K3jyzwA',
    chatId: '1415812326'
  }
};

// ── Initialize Firebase ────────────────────
firebase.initializeApp(CONFIG.firebase);
const db = firebase.database();

// ── DOM References ─────────────────────────
const form = document.getElementById('request-form');
const urlInput = document.getElementById('yt-url');
const segmentsInput = document.getElementById('segments');
const emailInput = document.getElementById('email');
const nameInput = document.getElementById('name');
const submitBtn = document.getElementById('submit-btn');
const statusList = document.getElementById('status-list');
const emptyState = document.getElementById('empty-state');
const clearBtn = document.getElementById('clear-history-btn');
const toastContainer = document.getElementById('toast-container');

// ── Local Storage Key ──────────────────────
const STORAGE_KEY = 'yt_queue_requests';

// ═══════════════════════════════════════════
//  TIME NORMALIZATION
// ═══════════════════════════════════════════

/**
 * Normalize a time string to HH:MM:SS format.
 * Handles: '27:00' → '00:27:00', '1:00:45' → '01:00:45',
 *          '1.00.45' → '01:00:45', '1:5:9' → '01:05:09'
 * Auto-carries: seconds >= 60 → minutes, minutes >= 60 → hours.
 */
function normalizeTime(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // Trim and replace dots / spaces used as separators with colons
  let cleaned = raw.trim().replace(/[\.\s]+/g, ':');

  // Remove any non-digit, non-colon characters
  cleaned = cleaned.replace(/[^0-9:]/g, '');
  if (!cleaned) return null;

  // Split into parts
  const parts = cleaned.split(':').map(p => parseInt(p, 10) || 0);

  let hours = 0, minutes = 0, seconds = 0;

  if (parts.length === 1) {
    // Just seconds (e.g. '90')
    seconds = parts[0];
  } else if (parts.length === 2) {
    // MM:SS
    minutes = parts[0];
    seconds = parts[1];
  } else {
    // H:MM:SS (or more, take last 3)
    const tail = parts.slice(-3);
    hours = tail.length === 3 ? tail[0] : 0;
    minutes = tail.length >= 2 ? tail[tail.length - 2] : 0;
    seconds = tail[tail.length - 1];
  }

  // Auto-carry
  if (seconds >= 60) {
    minutes += Math.floor(seconds / 60);
    seconds = seconds % 60;
  }
  if (minutes >= 60) {
    hours += Math.floor(minutes / 60);
    minutes = minutes % 60;
  }

  const pad = n => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

// ═══════════════════════════════════════════
//  SEGMENT PARSING
// ═══════════════════════════════════════════

/** Separators regex: - – — ~ → -> => */
const SEP_REGEX = /\s*(?:=>|->|→|—|–|~|-)\s*/;

/**
 * Parse textarea content into an array of {start, end} segments.
 * Returns { segments: [...], errors: [...] }
 */
function parseSegments(text) {
  const lines = text.split('\n');
  const segments = [];
  const errors = [];

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return; // skip empty

    const parts = trimmed.split(SEP_REGEX);
    if (parts.length < 2) {
      errors.push({ line: idx + 1, message: `Line ${idx + 1}: Cannot find start/end separator` });
      return;
    }

    const startRaw = parts[0];
    const endRaw = parts[parts.length - 1]; // take last part in case of multiple separators

    const start = normalizeTime(startRaw);
    const end = normalizeTime(endRaw);

    if (!start) {
      errors.push({ line: idx + 1, message: `Line ${idx + 1}: Invalid start time "${startRaw}"` });
      return;
    }
    if (!end) {
      errors.push({ line: idx + 1, message: `Line ${idx + 1}: Invalid end time "${endRaw}"` });
      return;
    }

    segments.push({ start, end });
  });

  return { segments, errors };
}

// ═══════════════════════════════════════════
//  VALIDATION
// ═══════════════════════════════════════════

function isValidYouTubeUrl(url) {
  return /(?:youtube\.com|youtu\.be)/i.test(url);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function clearErrors() {
  document.querySelectorAll('.field-error').forEach(el => (el.textContent = ''));
  document.querySelectorAll('.field').forEach(el => {
    el.classList.remove('field-valid', 'field-invalid');
  });
}

function setError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg;
}

// ═══════════════════════════════════════════
//  TOAST NOTIFICATIONS
// ═══════════════════════════════════════════

const TOAST_ICONS = {
  success: '✓',
  error: '✕',
  info: 'ℹ'
};

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type] || 'ℹ'}</span><span>${escapeHtml(message)}</span>`;

  toast.addEventListener('click', () => dismissToast(toast));
  toastContainer.appendChild(toast);

  // Auto-dismiss after 4s
  const timer = setTimeout(() => dismissToast(toast), 4000);
  toast._timer = timer;
}

function dismissToast(toast) {
  if (toast._dismissed) return;
  toast._dismissed = true;
  clearTimeout(toast._timer);
  toast.classList.add('removing');
  toast.addEventListener('animationend', () => toast.remove());
}

// ═══════════════════════════════════════════
//  FORM SUBMISSION
// ═══════════════════════════════════════════

function setLoading(loading) {
  submitBtn.disabled = loading;
  submitBtn.classList.toggle('loading', loading);
  urlInput.disabled = loading;
  segmentsInput.disabled = loading;
  emailInput.disabled = loading;
  nameInput.disabled = loading;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors();

  const url = urlInput.value.trim();
  const email = emailInput.value.trim();
  const name = nameInput.value.trim();
  const rawSegments = segmentsInput.value;

  // ── Validate ──
  let valid = true;

  if (!url) {
    setError('url-error', 'Please enter a YouTube URL.');
    valid = false;
  } else if (!isValidYouTubeUrl(url)) {
    setError('url-error', 'URL must be a valid youtube.com or youtu.be link.');
    valid = false;
  }

  if (!email) {
    setError('email-error', 'Please enter your email.');
    valid = false;
  } else if (!isValidEmail(email)) {
    setError('email-error', 'Please enter a valid email address.');
    valid = false;
  }

  const { segments, errors } = parseSegments(rawSegments);

  if (errors.length > 0) {
    setError('segments-error', errors.map(e => e.message).join('; '));
    flashSegments(false);
    valid = false;
  } else if (segments.length === 0) {
    setError('segments-error', 'Please enter at least one time segment.');
    valid = false;
  } else {
    flashSegments(true);
  }

  if (!valid) return;

  // ── Submit ──
  setLoading(true);

  const requestId = 'req_' + Date.now();
  const payload = {
    url,
    segments,
    email,
    name: name || 'Anonymous',
    status: 'pending',
    created_at: new Date().toISOString(),
    processed_at: null,
    result_links: [],
    error_message: null
  };

  try {
    // Save to Firebase
    await db.ref(`requests/${requestId}`).set(payload);

    // Save ID to localStorage
    saveRequestId(requestId);

    // Send Telegram notification (fire-and-forget, don't block on failure)
    sendTelegramNotification(payload, requestId).catch(err => {
      console.warn('Telegram notification failed:', err);
    });

    // Success!
    showToast('Request submitted successfully!', 'success');
    form.reset();
    renderStatusList();
    listenToRequest(requestId);
  } catch (err) {
    console.error('Firebase write error:', err);
    showToast('Failed to submit request. Please try again.', 'error');
  } finally {
    setLoading(false);
  }
});

// ── Flash segments textarea ──
function flashSegments(isValid) {
  const field = segmentsInput.closest('.field');
  const cls = isValid ? 'field-valid' : 'field-invalid';
  field.classList.add(cls);
  setTimeout(() => field.classList.remove(cls), 1200);
}

// ═══════════════════════════════════════════
//  TELEGRAM NOTIFICATION
// ═══════════════════════════════════════════

async function sendTelegramNotification(payload, requestId) {
  const timestamp = new Date().toLocaleString();
  const text = [
    '🎬 <b>New request!</b>',
    `From: ${escapeHtml(payload.name)} (${escapeHtml(payload.email)})`,
    `URL: ${escapeHtml(payload.url)}`,
    `Segments: ${payload.segments.length}`,
    `ID: <code>${requestId}</code>`,
    `Time: ${timestamp}`
  ].join('\n');

  const apiUrl = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;

  await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CONFIG.telegram.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
}

// ═══════════════════════════════════════════
//  LOCAL STORAGE HELPERS
// ═══════════════════════════════════════════

function getRequestIds() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveRequestId(id) {
  const ids = getRequestIds();
  if (!ids.includes(id)) {
    ids.unshift(id); // newest first
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  }
}

function clearRequestHistory() {
  // Detach Firebase listeners
  const ids = getRequestIds();
  ids.forEach(id => {
    try { db.ref(`requests/${id}`).off(); } catch (_) {}
  });
  localStorage.removeItem(STORAGE_KEY);
  renderStatusList();
  showToast('History cleared.', 'info');
}

clearBtn.addEventListener('click', clearRequestHistory);

// ═══════════════════════════════════════════
//  STATUS TRACKING
// ═══════════════════════════════════════════

const activeListeners = new Set();

function listenToRequest(requestId) {
  if (activeListeners.has(requestId)) return;
  activeListeners.add(requestId);

  db.ref(`requests/${requestId}`).on('value', (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    updateStatusItem(requestId, data);
  }, (err) => {
    console.error(`Listener error for ${requestId}:`, err);
  });
}

function updateStatusItem(requestId, data) {
  let item = document.getElementById(`status-${requestId}`);

  if (!item) {
    item = document.createElement('div');
    item.id = `status-${requestId}`;
    item.className = 'status-item';
    statusList.appendChild(item);
  }

  const truncatedUrl = truncateUrl(data.url || '', 50);
  const createdAt = data.created_at ? formatRelativeTime(data.created_at) : '';
  const segCount = data.segments ? data.segments.length : 0;
  const badgeClass = `badge badge-${data.status || 'pending'}`;
  const statusLabel = (data.status || 'pending').charAt(0).toUpperCase() + (data.status || 'pending').slice(1);

  let extras = '';

  if (data.status === 'done' && data.result_links && data.result_links.length > 0) {
    const links = data.result_links
      .map((link, i) => `<a href="${escapeAttr(link)}" target="_blank" rel="noopener">📥 Clip ${i + 1}</a>`)
      .join('');
    extras = `<div class="status-results">${links}</div>`;
  }

  if (data.status === 'error' && data.error_message) {
    extras = `<div class="status-error-msg">⚠ ${escapeHtml(data.error_message)}</div>`;
  }

  item.innerHTML = `
    <div class="status-item-row">
      <span class="status-url" title="${escapeAttr(data.url || '')}">${escapeHtml(truncatedUrl)}</span>
      <span class="${badgeClass}">${statusLabel}</span>
    </div>
    <div class="status-meta">
      <span class="segment-count">${segCount} segment${segCount !== 1 ? 's' : ''}</span>
      <span>${createdAt}</span>
    </div>
    ${extras}
  `;

  // Hide empty state
  if (emptyState) emptyState.style.display = 'none';
}

function renderStatusList() {
  const ids = getRequestIds();

  // Clear existing items
  statusList.querySelectorAll('.status-item').forEach(el => el.remove());

  if (ids.length === 0) {
    if (emptyState) emptyState.style.display = '';
    return;
  }

  if (emptyState) emptyState.style.display = 'none';

  ids.forEach(id => listenToRequest(id));
}

// ═══════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncateUrl(url, max) {
  if (url.length <= max) return url;
  return url.substring(0, max) + '…';
}

function formatRelativeTime(isoString) {
  try {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;

    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

// ═══════════════════════════════════════════
//  INITIALIZATION
// ═══════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  renderStatusList();
});
