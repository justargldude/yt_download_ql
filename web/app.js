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
const sourceSelect = document.getElementById('source-select');
const sourceField = document.getElementById('field-source');
const fullDownloadCheckbox = document.getElementById('full-download');
const liveBadge = document.getElementById('live-badge');
const segmentsField = document.getElementById('field-segments');

// ═══════════════════════════════════════════
//  LIVE STREAM DETECTION
// ═══════════════════════════════════════════

function isLiveUrl(url) {
  return /\/live\//i.test(url) || /[?&]live=/i.test(url);
}

// Normalize YouTube URL → video ID for dedup
function extractYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) {
      return u.pathname.slice(1).split('/')[0];
    }
    if (u.hostname.includes('youtube.com')) {
      return u.searchParams.get('v') || u.pathname.split('/').pop();
    }
  } catch {}
  return null;
}

if (urlInput) {
  urlInput.addEventListener('input', () => {
    const url = urlInput.value.trim();
    if (isLiveUrl(url)) {
      if (liveBadge) liveBadge.style.display = '';
    } else {
      if (liveBadge) liveBadge.style.display = 'none';
    }
  });
}

// ── Local Storage ──────────────────────────
const STORAGE_KEY = 'yt_cut_requests';
const EMAILS_STORAGE_KEY = 'yt_cut_saved_emails';
const requestDataMap = new Map();

// ═══════════════════════════════════════════
//  SAVED EMAILS
// ═══════════════════════════════════════════

function getSavedEmails() {
  try {
    return JSON.parse(localStorage.getItem(EMAILS_STORAGE_KEY)) || [];
  } catch { return []; }
}

function saveEmail(email) {
  if (!email) return;
  let emails = getSavedEmails();
  // Move to front if already exists, otherwise prepend
  emails = emails.filter(e => e !== email);
  emails.unshift(email);
  // Keep max 10
  if (emails.length > 10) emails = emails.slice(0, 10);
  localStorage.setItem(EMAILS_STORAGE_KEY, JSON.stringify(emails));
  refreshEmailUI();
}

function removeEmail(email) {
  let emails = getSavedEmails().filter(e => e !== email);
  localStorage.setItem(EMAILS_STORAGE_KEY, JSON.stringify(emails));
  refreshEmailUI();
}

function refreshEmailUI() {
  const emails = getSavedEmails();
  // Refresh datalist
  const datalist = document.getElementById('saved-emails');
  if (datalist) {
    datalist.innerHTML = emails.map(e => `<option value="${e}"></option>`).join('');
  }
  // Show/hide manage button
  const manageBtn = document.getElementById('manage-emails-btn');
  if (manageBtn) manageBtn.style.display = emails.length > 0 ? '' : 'none';
  // Refresh panel list
  renderSavedEmailsList();
}

function renderSavedEmailsList() {
  const listEl = document.getElementById('saved-emails-list');
  if (!listEl) return;
  const emails = getSavedEmails();
  if (emails.length === 0) {
    listEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.8rem;padding:8px 0">Chưa có email nào được lưu.</p>';
    return;
  }
  listEl.innerHTML = emails.map(e => `
    <div class="saved-email-item">
      <span class="saved-email-addr">${escapeHtml(e)}</span>
      <button type="button" class="btn-remove-email" data-email="${escapeHtml(e)}" title="Xoá">✕</button>
    </div>
  `).join('');
  // Attach remove handlers
  listEl.querySelectorAll('.btn-remove-email').forEach(btn => {
    btn.addEventListener('click', () => {
      removeEmail(btn.dataset.email);
      showToast('Đã xoá email khỏi danh sách.', 'info');
    });
  });
}

// Init saved emails on load
(function initSavedEmails() {
  refreshEmailUI();
  const emails = getSavedEmails();
  if (emails.length > 0 && emailInput) {
    emailInput.value = emails[0]; // Auto-fill most recent
  }
  // Manage panel toggle
  const manageBtn = document.getElementById('manage-emails-btn');
  const panel = document.getElementById('saved-emails-panel');
  const closeBtn = document.getElementById('close-emails-panel');
  if (manageBtn && panel) {
    manageBtn.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? '' : 'none';
      renderSavedEmailsList();
    });
  }
  if (closeBtn && panel) {
    closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
  }
})();

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

const TOAST_ICONS = { success: '✓', error: '✕', info: 'i' };

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
  [urlInput, segmentsInput, emailInput, nameInput, sourceSelect].forEach(el => { if (el) el.disabled = loading; });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors();

  const url = urlInput.value.trim();
  const email = emailInput.value.trim();
  const name = nameInput.value.trim();
  const rawSegments = segmentsInput.value;
  const selectedSource = sourceSelect?.value || '';

  let valid = true;

  if (!url && !selectedSource) { setError('url-error', 'Nhập link YouTube hoặc chọn video đã tải.'); valid = false; }
  else if (url && !isValidYouTubeUrl(url)) { setError('url-error', 'Link phải là youtube.com hoặc youtu.be.'); valid = false; }

  if (!email) { setError('email-error', 'Vui lòng nhập email.'); valid = false; }
  else if (!isValidEmail(email)) { setError('email-error', 'Email không hợp lệ.'); valid = false; }

  const { segments, errors } = parseSegments(rawSegments);
  const isFullDownload = segments.length === 0 && errors.length === 0;
  // Chỉ báo lỗi nếu có nhập segments nhưng sai format
  if (errors.length > 0) {
    setError('segments-error', errors.join('; '));
    flashField('field-segments', false);
    valid = false;
  } else if (segments.length > 0) {
    flashField('field-segments', true);
  }

  if (!valid) return;

  // Lấy URL từ source nếu chọn video đã tải
  const finalUrl = url || (sourceSelect?.selectedOptions[0]?.dataset?.url || '');

  setLoading(true);

  // ── Duplicate URL check: kiểm tra xem có request pending/processing cùng URL không ──
  const videoId = extractYouTubeVideoId(finalUrl);
  try {
    const snapshot = await db.ref('requests').once('value');
    const allRequests = snapshot.val();
    if (allRequests && videoId) {
      for (const [existingId, req] of Object.entries(allRequests)) {
        if (req.status !== 'pending' && req.status !== 'processing') continue;
        const existingVideoId = extractYouTubeVideoId(req.url);
        if (existingVideoId && existingVideoId === videoId) {
          setLoading(false);
          const confirmDup = confirm(
            `⚠️ Link này đã có trong hàng chờ (${existingId}, trạng thái: ${req.status}).\n\nBạn có chắc muốn gửi lại không?`
          );
          if (!confirmDup) return;
          setLoading(true);
          break;
        }
      }
    }
  } catch (e) {
    console.warn('Duplicate check failed:', e.message);
  }

  const requestId = 'req_' + Date.now();
  const payload = {
    url: finalUrl,
    segments: isFullDownload ? [] : segments,
    download_full: isFullDownload || false,
    email,
    name: name || 'Anonymous',
    status: 'pending',
    source_id: selectedSource || null,
    created_at: new Date().toISOString(),
    processed_at: null,
    result_links: [],
    error_message: null
  };

  try {
    await db.ref(`requests/${requestId}`).set(payload);
    saveRequestId(requestId);
    saveEmail(email); // Lưu email vào danh sách thường dùng
    sendTelegramNotification(payload, requestId).catch(() => {});
    showToast(selectedSource ? 'Đã gửi! Cắt lại từ source cache ⚡' : 'Đã gửi yêu cầu thành công!', 'success');
    form.reset();
    // Restore email after form.reset() clears everything
    emailInput.value = email;
    if (sourceSelect) sourceSelect.value = '';
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

// ═══════════════════════════════════════════
//  SOURCE SELECTOR
// ═══════════════════════════════════════════

function initSourceSelector() {
  if (!sourceSelect || !sourceField) return;

  db.ref('sources').on('value', (snapshot) => {
    const sources = snapshot.val();
    sourceSelect.innerHTML = '<option value="">-- Tải video mới --</option>';
    if (!sources) { sourceField.style.display = 'none'; return; }

    const now = Date.now();
    const MAX_AGE_MS = 12 * 3600000; // 12h
    let validCount = 0;

    Object.entries(sources).forEach(([hash, src]) => {
      const dlTime = src.downloaded_at ? new Date(src.downloaded_at).getTime() : 0;
      const ageMs = dlTime ? (now - dlTime) : Infinity;

      // Xoá entry đã hết hạn khỏi Firebase
      if (ageMs > MAX_AGE_MS) {
        db.ref(`sources/${hash}`).remove().catch(() => {});
        return;
      }

      validCount++;
      const opt = document.createElement('option');
      opt.value = hash;
      const sizeMB = src.file_size_mb ? `${src.file_size_mb} MB` : '';
      const url = src.url || src.title || hash;
      const truncUrl = url.length > 55 ? url.substring(0, 55) + '…' : url;
      const hoursLeft = Math.max(0, 12 - ageMs / 3600000).toFixed(0);
      opt.textContent = `♻️ ${truncUrl} (${sizeMB}, còn ${hoursLeft}h)`;
      opt.dataset.url = src.url || '';
      sourceSelect.appendChild(opt);
    });

    sourceField.style.display = validCount > 0 ? '' : 'none';
  });

  sourceSelect.addEventListener('change', () => {
    const selected = sourceSelect.selectedOptions[0];
    if (selected && selected.dataset.url) {
      urlInput.value = selected.dataset.url;
    }
  });
}

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
const STEP_NAMES = ['Tải video', 'Upload', 'Gửi email'];

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

// ═══════════════════════════════════════════
//  REUSE & RETRY ACTIONS
// ═══════════════════════════════════════════

function reuseInForm(requestId) {
  const data = requestDataMap.get(requestId);
  if (!data) return;
  if (urlInput) {
    urlInput.value = data.url || '';
    urlInput.dispatchEvent(new Event('input'));
  }
  if (emailInput) emailInput.value = data.email || '';
  if (nameInput) nameInput.value = data.name || '';
  if (segmentsInput) {
    if (data.segments && data.segments.length > 0) {
      segmentsInput.value = data.segments.map(s => `${s.start} - ${s.end}`).join('\n');
    } else {
      segmentsInput.value = '';
    }
  }
  showToast('Đã điền lại thông tin video vào form!', 'info');
  form.scrollIntoView({ behavior: 'smooth' });
}
window.reuseInForm = reuseInForm;

async function retryRequest(requestId) {
  const data = requestDataMap.get(requestId);
  if (!data) return;

  const newReqId = 'req_' + Date.now();
  const payload = {
    url: data.url,
    segments: data.segments || [],
    download_full: data.download_full || false,
    email: data.email,
    name: data.name || 'Anonymous',
    status: 'pending',
    source_id: data.source_id || null,
    created_at: new Date().toISOString(),
    processed_at: null,
    result_links: [],
    error_message: null
  };

  try {
    await db.ref(`requests/${newReqId}`).set(payload);
    saveRequestId(newReqId);
    if (data.email) saveEmail(data.email);
    listenToRequest(newReqId);
    showToast('Đã gửi lại yêu cầu cắt video!', 'success');
  } catch (err) {
    showToast('Gửi lại thất bại: ' + err.message, 'error');
  }
}
window.retryRequest = retryRequest;

// ═══════════════════════════════════════════
//  FIREBASE HISTORY SYNC BY EMAIL
// ═══════════════════════════════════════════

function syncHistoryByEmail(email) {
  if (!email || !isValidEmail(email)) return;
  db.ref('requests').orderByChild('email').equalTo(email).limitToLast(50).once('value', (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    let count = 0;
    Object.keys(data).forEach(id => {
      saveRequestId(id);
      listenToRequest(id);
      count++;
    });
    if (count > 0) {
      showToast(`Đã đồng bộ ${count} yêu cầu của ${email}`, 'info');
      applyFilter();
    }
  });
}
window.syncHistoryByEmail = syncHistoryByEmail;

// ═══════════════════════════════════════════
//  FILTER TABS
// ═══════════════════════════════════════════

let currentFilter = 'all';

function applyFilter() {
  const items = statusList.querySelectorAll('.status-item');
  let visibleCount = 0;

  items.forEach(item => {
    const id = item.id.replace('status-', '');
    const data = requestDataMap.get(id);
    if (!data) { item.style.display = 'none'; return; }

    const status = data.status || 'pending';
    let match = false;

    if (currentFilter === 'all') match = true;
    else if (currentFilter === 'processing' && (status === 'processing' || status === 'pending' || status === 'cancelling')) match = true;
    else if (currentFilter === 'error' && status === 'error') match = true;
    else if (currentFilter === 'done' && (status === 'done' || status === 'cancelled')) match = true;

    item.style.display = match ? '' : 'none';
    if (match) visibleCount++;
  });

  if (emptyState) {
    emptyState.style.display = visibleCount === 0 ? '' : 'none';
  }
}

function initFilterTabs() {
  const filterTabs = document.querySelectorAll('.filter-tab');
  filterTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      filterTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.filter || 'all';
      applyFilter();
    });
  });
}

function updateStatusItem(requestId, data) {
  let item = document.getElementById(`status-${requestId}`);
  if (!item) {
    item = document.createElement('div');
    item.id = `status-${requestId}`;
    statusList.appendChild(item);
  }

  const status = data.status || 'pending';
  const isActiveCutting = status === 'processing' || status === 'pending';
  item.className = `status-item status-${status} ${isActiveCutting ? 'status-active-cutting' : ''}`;

  const fullUrl = data.url || '';
  const createdAt = data.created_at ? formatRelativeTime(data.created_at) : '';
  const segments = data.segments || [];
  const segCount = segments.length;
  const isFullDownload = segCount === 0 || data.download_full === true;
  const statusLabels = {
    pending: 'Đang chờ',
    processing: '⚡ Đang cắt...',
    done: 'Hoàn thành',
    error: '⚠️ Lỗi',
    cancelling: 'Đang huỷ',
    cancelled: 'Đã huỷ'
  };
  const statusLabel = statusLabels[status] || status;

  // ── Build request detail block ──
  let detailHtml = '<div class="req-detail-grid">';

  // Row: URL (clickable, full)
  detailHtml += `
    <div class="req-detail-row">
      <span class="req-detail-icon">🔗</span>
      <a href="${escapeAttr(fullUrl)}" target="_blank" rel="noopener" class="req-detail-url" title="${escapeAttr(fullUrl)}">${escapeHtml(fullUrl)}</a>
    </div>`;

  // Row: Requester name + email
  const reqName = data.name || 'Anonymous';
  const reqEmail = data.email || '';
  detailHtml += `
    <div class="req-detail-row">
      <span class="req-detail-icon">👤</span>
      <span class="req-detail-text"><strong>${escapeHtml(reqName)}</strong>${reqEmail ? ` · ${escapeHtml(reqEmail)}` : ''}</span>
    </div>`;

  // Row: Mode + segments list
  if (isFullDownload) {
    detailHtml += `
      <div class="req-detail-row">
        <span class="req-detail-icon">📹</span>
        <span class="req-detail-text req-detail-mode-full">Tải full video</span>
      </div>`;
  } else {
    detailHtml += `
      <div class="req-detail-row">
        <span class="req-detail-icon">✂️</span>
        <span class="req-detail-text">Cắt <strong>${segCount}</strong> đoạn</span>
      </div>`;
    // Show actual segment timestamps
    detailHtml += '<div class="req-segments-list">';
    segments.forEach((seg, i) => {
      detailHtml += `<span class="req-segment-chip">${i + 1}. ${escapeHtml(seg.start)} → ${escapeHtml(seg.end)}</span>`;
    });
    detailHtml += '</div>';
  }

  // Row: Live badge
  if (data.is_live || (data.progress && data.progress.is_live)) {
    detailHtml += `
      <div class="req-detail-row">
        <span class="req-detail-icon">🔴</span>
        <span class="req-detail-text req-detail-live">Live stream</span>
      </div>`;
  }

  // Row: Retry count
  if (data.retry_count && data.retry_count > 0) {
    detailHtml += `
      <div class="req-detail-row">
        <span class="req-detail-icon">🔄</span>
        <span class="req-detail-text req-detail-retry">Đã thử lại ${data.retry_count} lần</span>
      </div>`;
  }

  // Row: Submitted time
  detailHtml += `
    <div class="req-detail-row">
      <span class="req-detail-icon">🕐</span>
      <span class="req-detail-text req-detail-time">${createdAt}</span>
    </div>`;

  detailHtml += '</div>';

  let extras = '';
  const progress = data.progress;

  // ── Progress bar + segment info ──
  if (status === 'processing' && progress && progress.step === 'downloading') {
    if (progress.is_live) {
      extras += `
        <div class="progress-live-info">
          <span class="progress-live-dot"></span>
          <span>Đang tải live stream...</span>
        </div>`;
    }
    const pct = Math.min(progress.percent || 0, 100);
    const segInfo = progress.segment_index ? `Đoạn ${progress.segment_index}/${progress.segment_total}` : '';
    const rangeInfo = progress.segment_range && progress.segment_range !== 'done' ? `${progress.segment_range}` : '';
    const dlInfo = progress.downloaded ? `${progress.downloaded}` : '';
    const totalInfo = progress.total_size ? ` / ${progress.total_size}` : '';
    const speedInfo = progress.speed ? `${progress.speed}` : '';
    const etaInfo = progress.eta ? `ETA ${progress.eta}` : '';
    const fileInfo = progress.current_file ? `${progress.current_file}` : '';
    const elapsedHtml = data.processing_started_at
      ? `<span class="elapsed-time" data-start="${escapeAttr(data.processing_started_at)}">${formatElapsed(data.processing_started_at)}</span>`
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
    const totalSteps = progress.total_steps || 3;
    const stepNames = totalSteps === 2 ? ['Tải video', 'Upload & Email'] : STEP_NAMES;
    let stepsHtml = '';
    stepNames.forEach((name, idx) => {
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
    extras += `<div class="elapsed-time" data-start="${escapeAttr(data.processing_started_at)}">${formatElapsed(data.processing_started_at)}</div>`;
  }

  // ── Result links ──
  if (status === 'done' && data.result_links && data.result_links.length > 0) {
    const links = data.result_links
      .filter(l => !l.startsWith('file://'))
      .map((link, i) => `<a href="${escapeAttr(link)}" target="_blank" rel="noopener">Clip ${i + 1}</a>`)
      .join('');
    if (links) {
      extras += `<div class="result-links">${links}</div>`;
    }
  }

  // ── Done info ──
  if (status === 'done') {
    const hlCount = data.highlight_count || segCount;
    const sizeMB = data.total_size_mb ? `${data.total_size_mb} MB` : '';
    if (data.download_full) {
      extras += `<div class="progress-stats" style="margin-top:6px"><span>📹 Full video ${sizeMB ? '· ' + sizeMB : ''} · Đã gửi email</span></div>`;
    } else {
      extras += `<div class="progress-stats" style="margin-top:6px"><span>${hlCount} clip${hlCount !== 1 ? 's' : ''} ${sizeMB ? '· ' + sizeMB : ''} · Đã gửi email</span></div>`;
    }
  }

  // ── Error message ──
  if (status === 'error' && data.error_message) {
    extras += `<div class="error-msg">⚠️ Lỗi: ${escapeHtml(data.error_message)}</div>`;
  }

  // ── Action Buttons (Retry, Reuse, Cancel) ──
  let actionsHtml = '<div class="req-actions">';
  if (status === 'error') {
    actionsHtml += `<button type="button" class="btn-action btn-retry" onclick="retryRequest('${escapeAttr(requestId)}')">🔄 Thử lại ngay</button>`;
    actionsHtml += `<button type="button" class="btn-action btn-reuse" onclick="reuseInForm('${escapeAttr(requestId)}')">📝 Sửa / Điền lại form</button>`;
  } else if (status === 'pending' || status === 'processing') {
    actionsHtml += `<button type="button" class="btn-action btn-reuse" onclick="reuseInForm('${escapeAttr(requestId)}')">📝 Xem / Sửa lại</button>`;
    actionsHtml += `<button type="button" class="btn-cancel" onclick="cancelRequest('${escapeAttr(requestId)}')">🚫 Huỷ yêu cầu</button>`;
  } else if (status === 'done') {
    actionsHtml += `<button type="button" class="btn-action btn-reuse" onclick="reuseInForm('${escapeAttr(requestId)}')">📝 Cắt lại / Dùng lại thông tin</button>`;
  } else {
    actionsHtml += `<button type="button" class="btn-action btn-reuse" onclick="reuseInForm('${escapeAttr(requestId)}')">📝 Dùng lại thông tin</button>`;
  }
  actionsHtml += '</div>';

  extras += actionsHtml;

  item.innerHTML = `
    <div class="status-item-header">
      <span class="req-id">${escapeHtml(requestId)}</span>
      <span class="badge badge-${status}">${statusLabel}</span>
    </div>
    ${detailHtml}
    ${extras}
  `;

  applyFilter();
}

function renderStatusList() {
  const ids = getRequestIds();
  statusList.querySelectorAll('.status-item').forEach(el => el.remove());
  if (ids.length === 0) { if (emptyState) emptyState.style.display = ''; return; }
  if (emptyState) emptyState.style.display = 'none';
  ids.forEach(id => listenToRequest(id));
  applyFilter();
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
  initSourceSelector();
  initFilterTabs();

  // Attach sync history button
  const syncBtn = document.getElementById('sync-history-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      const email = emailInput?.value?.trim();
      if (email) {
        syncHistoryByEmail(email);
      } else {
        // Sync all recent from Firebase
        db.ref('requests').limitToLast(30).once('value', (snapshot) => {
          const data = snapshot.val();
          if (!data) return;
          let count = 0;
          Object.keys(data).forEach(id => {
            saveRequestId(id);
            listenToRequest(id);
            count++;
          });
          showToast(`Đã tải ${count} yêu cầu gần đây từ Firebase`, 'info');
          applyFilter();
        });
      }
    });
  }

  // Auto sync on email input change/blur
  if (emailInput) {
    emailInput.addEventListener('blur', () => {
      const email = emailInput.value.trim();
      if (email && isValidEmail(email)) syncHistoryByEmail(email);
    });
    // Auto-sync initial email if present
    if (emailInput.value && isValidEmail(emailInput.value.trim())) {
      syncHistoryByEmail(emailInput.value.trim());
    }
  }

  // Update elapsed times every second
  setInterval(() => {
    document.querySelectorAll('.elapsed-time[data-start]').forEach(el => {
      el.textContent = formatElapsed(el.dataset.start);
    });
  }, 1000);
});
