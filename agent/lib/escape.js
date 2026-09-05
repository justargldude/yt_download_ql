// lib/escape.js — HTML/Telegram escaping helpers (single source of truth).
// Used by emailer.js (nodemailer HTML bodies) and telegram.js
// (parse_mode: HTML). All user-controlled strings (name, url, email,
// error messages) MUST pass through these before interpolation.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape a string for safe interpolation into an HTML document. */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** Escape for Telegram HTML parse mode: <, >, & are special. */
export function escapeTelegram(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}
