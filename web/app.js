/* ═══════════════════════════════════════════
   YT CUT FOR HNYUQTL v4.0 — Application Logic
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

// ── Local Storage ──────────────────────────
const STORAGE_KEY = 'yt_cut_requests';
const requestDataMap = new Map();

// ═══════════════════════════════════════════
//  TIME NORMALIZATION
// ═══════════════════════════════════════════

function normalizeTime(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let cleaned = raw.trim().replace(/[.\s]+/g, ':');
  cleaned = cleaned.replace(/[^0-9:]/g, '');
  if (!cleaned) return null;
  const parts = cleaned.split(':').map(p => parseInt(p, 10) || 0);
  let hours = 0, minutes = 0, seconds = 0;
  if (parts.length === 1) { seconds = parts[0]; }
  else if (parts.length === 2) { minutes = parts[0]; seconds = parts[1]; }
  else { const tail = parts.slice(-3); hours = tail.length === 3 ? tail[0] : 0; minutes = tail.length >= 2 ? tail[tail.length - 2] : 0; seconds = tail[tail.length - 1]; }
  if (seconds >= 60) { minutes += Math.floor(seconds / 60); seconds = seconds % 60; }
  if (minutes >= 60) { hours += Math.floor(minutes / 60); minutes = minutes % 60; }
  const pad = n => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

// ═══════════════════════════════════════════
//  SEGMENT PARSING
// ═══════════════════════════════════════════

const SEP_REGEX = /\s*(?:=>|->|→|—|–|~|-)\s*/;

function parseSegments(text) {
  const lines = text.split('\n');
  const segments = [];
  const errors = [];
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parts = trimmed.split(SEP_REGEX);
    if (parts.length < 2) { errors.push(`Dòng ${idx + 1}: Không tìm thấy dấu ngăn`); return; }
    const start = normalizeTime(parts[0]);
    const end = normalizeTime(parts[parts.length - 1]);
    if (!start) { errors.push(`Dòng ${idx + 1}: Thời gian bắt đầu không hợp lệ`); return; }
    if (!end) { errors.push(`Dòng ${idx + 1}: Thời gian kết thúc không hợp lệ`); return; }
    segments.push({ start, end });
  });
  return { segments, errors };
}

// ═══════════════════════════════════════════
//  VALIDATION
// ═══════════════════════════════════════════

function isValidYouTubeUrl(url) { return /(?:youtube\.com|youtu\.be)/i.test(url); }
function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function clearErrors() {
  document.querySelectorAll('.field-error').forEach(el => (el.textContent = ''));
  document.querySelectorAll('.field').forEach(el => el.classList.remove('field-valid', 'field-invalid'));
}
function setError(id, msg) { const el = document.getElementById(id); if (el) el.textContent = msg; }

// ═══════════════════════════════════════════
//  TOAST NOTIFICATIONS
// ═══════════════════════════════════════════

const TOAST_ICONS = { success: '✅', error: '❌', info: 'ℹ️' };

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${TOAST_ICONS[type] || 'ℹ️'}</span><span>${escapeHtml(message)}</span>`;
  toast.addEventListener('click', () => dismissToast(toast));
  toastContainer.appendChild(toast);
  toast._timer = setTimeout(() => dismissToast(toast), 4000);
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
  [urlInput, segmentsInput, emailInput, nameInput].forEach(el => { if (el) el.disabled = loading; });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors();

  const url = urlInput.value.trim();
  const email = emailInput.value.trim();
  const name = nameInput.value.trim();
  const rawSegments = segmentsInput.value;

  let valid = true;

  if (!url) { setError('url-error', 'Vui lòng nhập link YouTube.'); valid = false; }
  else if (!isValidYouTubeUrl(url)) { setError('url-error', 'Link phải là youtube.com hoặc youtu.be.'); valid = false; }

  if (!email) { setError('email-error', 'Vui lòng nhập email.'); valid = false; }
  else if (!isValidEmail(email)) { setError('email-error', 'Email không hợp lệ.'); valid = false; }

  const { segments, errors } = parseSegments(rawSegments);
  if (errors.length > 0) {
    setError('segments-error', errors.join('; '));
    flashField('field-segments', false);
    valid = false;
  } else if (segments.length === 0) {
    setError('segments-error', 'Cần ít nhất 1 đoạn thời gian.');
    valid = false;
  } else {
    flashField('field-segments', true);
  }

  if (!valid) return;

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
    await db.ref(`requests/${requestId}`).set(payload);
    saveRequestId(requestId);
    sendTelegramNotification(payload, requestId).catch(() => {});
    showToast('Đã gửi yêu cầu thành công!', 'success');
    form.reset();
    renderStatusList();
    listenToRequest(requestId);
  } catch (err) {
    console.error('Firebase write error:', err);
    showToast('Gửi thất bại. Vui lòng thử lại.', 'error');
  } finally {
    setLoading(false);
  }
});

function flashField(fieldId, isValid) {
  const field = document.getElementById(fieldId);
  if (!field) return;
  const cls = isValid ? 'field-valid' : 'field-invalid';
  field.classList.add(cls);
  setTimeout(() => field.classList.remove(cls), 1200);
}

// ═══════════════════════════════════════════
//  TELEGRAM NOTIFICATION
// ═══════════════════════════════════════════

async function sendTelegramNotification(payload, requestId) {
  const text = [
    '✂️ <b>Yêu cầu mới!</b>',
    `Từ: ${escapeHtml(payload.name)} (${escapeHtml(payload.email)})`,
    `URL: ${escapeHtml(payload.url)}`,
    `Segments: ${payload.segments.length}`,
    `ID: <code>${requestId}</code>`,
    `Time: ${new Date().toLocaleString()}`
  ].join('\n');
  await fetch(`https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CONFIG.telegram.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
}

// ═══════════════════════════════════════════
//  LOCAL STORAGE
// ═══════════════════════════════════════════

function getRequestIds() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; } }
function saveRequestId(id) {
  const ids = getRequestIds();
  if (!ids.includes(id)) { ids.unshift(id); localStorage.setItem(STORAGE_KEY, JSON.stringify(ids)); }
}
function clearRequestHistory() {
  getRequestIds().forEach(id => { try { db.ref(`requests/${id}`).off(); } catch (_) {} });
  activeListeners.clear();
  requestDataMap.clear();
  localStorage.removeItem(STORAGE_KEY);
  renderStatusList();
  showToast('Đã xoá lịch sử.', 'info');
}
clearBtn.addEventListener('click', clearRequestHistory);

// ═══════════════════════════════════════════
//  CANCEL REQUEST
// ═══════════════════════════════════════════

async function cancelRequest(requestId) {
  try {
    await db.ref(`requests/${requestId}/status`).set('cancelling');
    showToast('Đang huỷ yêu cầu...', 'info');
  } catch (err) {
    showToast('Huỷ thất bại: ' + err.message, 'error');
  }
}
window.cancelRequest = cancelRequest;

// ═══════════════════════════════════════════
//  AGENT STATUS
// ═══════════════════════════════════════════

function initAgentStatus() {
  const dotEl = document.getElementById('agent-dot');
  const textEl = document.getElementById('agent-status-text');

  function updateStatus(data) {
    if (!data || !data.last_heartbeat) {
      dotEl.className = 'agent-dot offline';
      textEl.textContent = 'Offline';
      return;
    }
    const age = Date.now() - new Date(data.last_heartbeat).getTime();
    if (age > 45000) {
      dotEl.className = 'agent-dot offline';
      textEl.textContent = 'Offline';
    } else {
      dotEl.className = 'agent-dot online';
      textEl.textContent = data.processing ? 'Đang xử lý...' : 'Online';
    }
  }

  db.ref('agent_status').on('value', (snap) => updateStatus(snap.val()));
  setInterval(() => {
    db.ref('agent_status').once('value', (snap) => updateStatus(snap.val()));
  }, 20000);
}

// ═══════════════════════════════════════════
//  STATUS TRACKING
// ═══════════════════════════════════════════

const activeListeners = new Set();
const STEP_NAMES = ['Tải & cắt', 'Upload', 'Email'];

function listenToRequest(requestId) {
  if (activeListeners.has(requestId)) return;
  activeListeners.add(requestId);
  db.ref(`requests/${requestId}`).on('value', (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    requestDataMap.set(requestId, data);
    updateStatusItem(requestId, data);
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

  const truncatedUrl = truncateUrl(data.url || '', 45);
  const createdAt = data.created_at ? formatRelativeTime(data.created_at) : '';
  const segCount = data.segments ? data.segments.length : 0;
  const status = data.status || 'pending';
  const statusLabels = {
    pending: 'Đang chờ',
    processing: 'Đang xử lý',
    done: 'Hoàn thành',
    error: 'Lỗi',
    cancelling: 'Đang huỷ',
    cancelled: 'Đã huỷ'
  };
  const statusLabel = statusLabels[status] || status;

  let extras = '';
  const progress = data.progress;

  // ── Progress bar + segment info ──
  if (status === 'processing' && progress && progress.step === 'downloading' && progress.percent != null) {
    const pct = Math.min(progress.percent, 100);
    const segInfo = progress.segment_index ? `📦 Đoạn ${progress.segment_index}/${progress.segment_total}` : '';
    const rangeInfo = progress.segment_range && progress.segment_range !== 'done' ? `⏱️ ${progress.segment_range}` : '';
    const dlInfo = progress.downloaded ? `${progress.downloaded}` : '';
    const totalInfo = progress.total_size ? ` / ${progress.total_size}` : '';
    const speedInfo = progress.speed ? `⚡ ${progress.speed}` : '';
    const etaInfo = progress.eta ? `ETA ${progress.eta}` : '';
    const fileInfo = progress.current_file ? `📄 ${progress.current_file}` : '';
    const elapsedHtml = data.processing_started_at
      ? `<span class="elapsed-time" data-start="${escapeAttr(data.processing_started_at)}">⏳ ${formatElapsed(data.processing_started_at)}</span>`
      : '';
    extras += `
      <div class="progress-container">
        ${segInfo || rangeInfo ? `<div class="progress-segment-info">${segInfo} ${rangeInfo}</div>` : ''}
        ${fileInfo ? `<div class="progress-file-info">${fileInfo}</div>` : ''}
        <div class="progress-bar-wrap"><div class="progress-bar" style="width: ${pct}%"></div></div>
        <div class="progress-stats">
          <span>${dlInfo}${totalInfo}</span>
          <span>${speedInfo}</span>
          <span>${etaInfo}</span>
          ${elapsedHtml}
        </div>
      </div>`;
  }

  // ── Step tracker ──
  if (status === 'processing' && progress) {
    const currentStep = progress.step_num || 1;
    let stepsHtml = '';
    STEP_NAMES.forEach((name, idx) => {
      const stepNum = idx + 1;
      let cls = '';
      let icon = String(stepNum);
      let detail = '';

      if (stepNum < currentStep) {
        cls = 'done'; icon = '✓';
      } else if (stepNum === currentStep) {
        cls = 'active'; icon = '⏳';
        if (progress.step === 'downloading') {
          if (progress.segment_index) {
            detail = `${progress.segment_index}/${progress.segment_total}`;
            if (progress.percent != null) detail += ` · ${Math.round(progress.percent)}%`;
          } else if (progress.percent != null) {
            detail = `${Math.round(progress.percent)}%`;
          }
        } else if (progress.step === 'uploading' && progress.current_file) {
          detail = progress.current_file;
        } else if (progress.step === 'emailing') {
          detail = 'đang gửi...';
        }
      }

      stepsHtml += `
        <div class="step-item ${cls}">
          <span class="step-icon">${icon}</span>
          <div>
            <div class="step-label">${name}</div>
            ${detail ? `<div class="step-detail">${escapeHtml(detail)}</div>` : ''}
          </div>
        </div>`;
    });
    extras += `<div class="step-tracker">${stepsHtml}</div>`;
  }

  // ── Elapsed time fallback ──
  if (status === 'processing' && data.processing_started_at && !progress) {
    extras += `<div class="elapsed-time" data-start="${escapeAttr(data.processing_started_at)}">⏳ ${formatElapsed(data.processing_started_at)}</div>`;
  }

  // ── Cancel button ──
  if (status === 'pending' || status === 'processing') {
    extras += `<button class="btn-cancel" onclick="cancelRequest('${escapeAttr(requestId)}')">❌ Huỷ</button>`;
  }

  // ── Result links ──
  if (status === 'done' && data.result_links && data.result_links.length > 0) {
    const links = data.result_links
      .filter(l => !l.startsWith('file://'))
      .map((link, i) => `<a href="${escapeAttr(link)}" target="_blank" rel="noopener">📥 Clip ${i + 1}</a>`)
      .join('');
    if (links) {
      extras += `<div class="result-links">${links}</div>`;
    }
  }

  // ── Done info ──
  if (status === 'done') {
    const hlCount = data.highlight_count || segCount;
    const sizeMB = data.total_size_mb ? `${data.total_size_mb} MB` : '';
    extras += `<div class="progress-stats" style="margin-top:6px"><span>✅ ${hlCount} clip${hlCount !== 1 ? 's' : ''} ${sizeMB ? '· ' + sizeMB : ''} · Đã gửi email</span></div>`;
  }

  // ── Error message ──
  if (status === 'error' && data.error_message) {
    extras += `<div class="error-msg">⚠ ${escapeHtml(data.error_message)}</div>`;
  }

  item.innerHTML = `
    <div class="status-item-header">
      <span class="status-url" title="${escapeAttr(data.url || '')}">${escapeHtml(truncatedUrl)}</span>
      <span class="badge badge-${status}">${statusLabel}</span>
    </div>
    <div class="status-meta">
      <span>✂️ ${segCount} đoạn</span>
      <span>${createdAt}</span>
    </div>
    ${extras}
  `;

  if (emptyState) emptyState.style.display = 'none';
}

function renderStatusList() {
  const ids = getRequestIds();
  statusList.querySelectorAll('.status-item').forEach(el => el.remove());
  if (ids.length === 0) { if (emptyState) emptyState.style.display = ''; return; }
  if (emptyState) emptyState.style.display = 'none';
  ids.forEach(id => listenToRequest(id));
}

// ═══════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════

function escapeHtml(str) { const div = document.createElement('div'); div.textContent = str; return div.innerHTML; }
function escapeAttr(str) { return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function truncateUrl(url, max) { if (url.length <= max) return url; return url.substring(0, max) + '…'; }

function formatRelativeTime(isoString) {
  try {
    const diffMs = Date.now() - new Date(isoString).getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'Vừa xong';
    if (diffMin < 60) return `${diffMin} phút trước`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} giờ trước`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay} ngày trước`;
    return new Date(isoString).toLocaleDateString('vi-VN', { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

function formatElapsed(startIso) {
  try {
    const diff = Math.floor((Date.now() - new Date(startIso).getTime()) / 1000);
    if (diff < 0) return '0s';
    if (diff < 60) return `${diff}s`;
    const m = Math.floor(diff / 60);
    const s = diff % 60;
    if (m < 60) return `${m}m${String(s).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return `${h}h${String(m % 60).padStart(2, '0')}m`;
  } catch { return ''; }
}

// ═══════════════════════════════════════════
//  INITIALIZATION
// ═══════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  renderStatusList();
  initAgentStatus();

  // Update elapsed times every second
  setInterval(() => {
    document.querySelectorAll('.elapsed-time[data-start]').forEach(el => {
      el.textContent = '⏳ ' + formatElapsed(el.dataset.start);
    });
  }, 1000);
});
