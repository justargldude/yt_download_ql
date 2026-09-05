/* ═══════════════════════════════════════════
   YT CUT — Pure utility helpers (app-utils.js)
   Classic script: attaches globalThis.YTUtils.
   Loaded BEFORE app.js; contains NO Firebase/DOM deps
   so it is unit-testable under node --test via
   new Function() harness (see tests/test-app-utils.test.js).
   ═══════════════════════════════════════════ */
(function (globalScope) {
  'use strict';

  // ── YouTube URL helpers ──────────────────────────
  const YT_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'youtu.be'];
  const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{6,15}$/;

  /** Extract 11-char video id from any YouTube URL shape; null otherwise. */
  function extractYouTubeVideoId(url) {
    if (!url || typeof url !== 'string') return null;
    try {
      const u = new URL(url.trim());
      if (u.hostname === 'youtu.be' || u.hostname.endsWith('.youtu.be')) {
        const id = u.pathname.split('/').filter(Boolean)[0] || '';
        return VIDEO_ID_RE.test(id) ? id : null;
      }
      if (!YT_HOSTS.includes(u.hostname)) return null;
      const v = u.searchParams.get('v');
      if (v && VIDEO_ID_RE.test(v)) return v;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && ['live', 'shorts', 'embed', 'v'].includes(parts[0])) {
        const id = parts[1];
        return VIDEO_ID_RE.test(id) ? id : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  function isValidYouTubeUrl(url) {
    return /(?:youtube\.com|youtu\.be)/i.test(url || '');
  }

  /** Detect live-stream URL shapes (/live/<id>, ?live=). */
  function isLiveUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /\/live\//i.test(url) || /[?&]live=/i.test(url);
  }

  // ── Time normalization ───────────────────────────

  /** '90:00' → '01:30:00'; '1:00:45' → '01:00:45'; garbage → null. */
  function normalizeTime(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let cleaned = raw.trim().replace(/[.\s]+/g, ':');
    cleaned = cleaned.replace(/[^0-9:]/g, '');
    if (!cleaned) return null;
    const parts = cleaned.split(':').map((p) => parseInt(p, 10) || 0);
    let hours = 0, minutes = 0, seconds = 0;
    if (parts.length === 1) { seconds = parts[0]; }
    else if (parts.length === 2) { minutes = parts[0]; seconds = parts[1]; }
    else {
      const tail = parts.slice(-3);
      hours = tail.length === 3 ? tail[0] : 0;
      minutes = tail.length >= 2 ? tail[tail.length - 2] : 0;
      seconds = tail[tail.length - 1];
    }
    if (seconds >= 60) { minutes += Math.floor(seconds / 60); seconds = seconds % 60; }
    if (minutes >= 60) { hours += Math.floor(minutes / 60); minutes = minutes % 60; }
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  /** Total seconds of an 'HH:MM:SS' string (null-safe). */
  function timeToSeconds(t) {
    if (!t) return null;
    const parts = String(t).split(':').map((p) => parseInt(p, 10) || 0);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0];
  }

  // ── Segment parsing ─────────────────────────────

  const SEP_REGEX = /\s*(?:=>|->|→|—|–|~|-)\s*/;

  /**
   * Parse the textarea content into { segments, errors }.
   * A line 'start - end' becomes { start: 'HH:MM:SS', end: 'HH:MM:SS' }.
   * Rejects: missing separator, invalid times, reversed ranges (start > end).
   */
  function parseSegments(text) {
    const lines = String(text || '').split('\n');
    const segments = [];
    const errors = [];
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parts = trimmed.split(SEP_REGEX);
      if (parts.length < 2) { errors.push(`Dòng ${idx + 1}: Không tìm thấy dấu ngăn cách`); return; }
      const start = normalizeTime(parts[0]);
      const end = normalizeTime(parts[parts.length - 1]);
      if (!start) { errors.push(`Dòng ${idx + 1}: Thời gian bắt đầu không hợp lệ`); return; }
      if (!end) { errors.push(`Dòng ${idx + 1}: Thời gian kết thúc không hợp lệ`); return; }
      // Reversed range guard: end must be AFTER start (ffmpeg would produce garbage)
      const startSec = timeToSeconds(start);
      const endSec = timeToSeconds(end);
      if (startSec !== null && endSec !== null && endSec <= startSec) {
        errors.push(`Dòng ${idx + 1}: Thời gian kết thúc phải sau thời gian bắt đầu`);
        return;
      }
      segments.push({ start, end });
    });
    return { segments, errors };
  }

  // ── Validation ──────────────────────────────────

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
  }

  // ── HTML escaping (string-based, works without DOM — test harness) ──
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

  // ── Formatting ──────────────────────────────────

  function truncateUrl(url, max) {
    if (!url) return '';
    if (url.length <= max) return url;
    return url.substring(0, Math.max(0, max - 1)) + '…';
  }

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

  // ── IDs ─────────────────────────────────────────

  /** Collision-proof request id (UUIDv4), unlike Date.now() (same-ms collisions). */
  function makeRequestId() {
    const c = globalScope.crypto;
    if (c && typeof c.randomUUID === 'function') return 'req_' + c.randomUUID();
    // Fallback for exotic environments without crypto.randomUUID
    return 'req_' + (c ? c.getRandomValues(new Uint32Array(4))
      .toString(16).padEnd(32, '0').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
      : String(Date.now()) + '-' + Math.random().toString(16).slice(2));
  }

  const YTUtils = {
    extractYouTubeVideoId,
    isValidYouTubeUrl,
    isLiveUrl,
    normalizeTime,
    timeToSeconds,
    SEP_REGEX,
    parseSegments,
    isValidEmail,
    escapeHtml,
    escapeAttr,
    truncateUrl,
    formatRelativeTime,
    formatElapsed,
    makeRequestId,
  };

  // Attach for both browsers (window) and the node test harness (globalThis)
  globalScope.YTUtils = YTUtils;
  if (typeof globalScope.window !== 'undefined') globalScope.window.YTUtils = YTUtils;
})(typeof window !== 'undefined' ? window : globalThis);
