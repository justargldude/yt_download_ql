// telegram.js — Gửi thông báo Telegram + consume RTDB notifications queue
import { ts } from './lib/logger.js';
import { escapeTelegram } from './lib/escape.js';

export { escapeTelegram };

/**
 * Gửi tin nhắn Telegram. Lỗi sẽ được bắt im lặng để không crash agent.
 * @param {object} config - App config
 * @param {string} text - Nội dung tin nhắn (hỗ trợ HTML)
 */
export async function sendTelegramMessage(config, text) {
  // Bỏ qua nếu chưa cấu hình Telegram
  if (!config.telegram?.botToken || !config.telegram?.chatId) {
    return;
  }

  const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text,
        parse_mode: 'HTML',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`${ts()} ⚠️ Telegram API error (${res.status}): ${body}`);
    }
  } catch (err) {
    // Không crash agent nếu Telegram lỗi
    console.warn(`${ts()} ⚠️ Telegram send failed: ${err.message}`);
  }
}

/**
 * Lắng nghe hàng đợi `notifications/` trong Firebase RTDB.
 *
 * Web client KHÔNG giữ bot token (token chỉ nằm trong config.json của
 * agent chạy trên máy người dùng). Client chỉ push payload vào
 * `notifications/{pushId}`; hàm này consume từng payload, chuyển tiếp
 * sang Telegram rồi xoá khỏi queue.
 *
 * Security: MỌI nội dung được escape bằng escapeTelegram trước khi gửi
 * (parse_mode HTML) — kể cả payload.text đã render sẵn phía client,
 * vì client là untrusted input. Queue có cap chống spam (max 50 pending,
 * bỏ quá hạn) và rate-limit 10 tin/phút.
 *
 * @param {object} config - App config (telegram credentials)
 * @param {object} db - firebase-admin Database instance
 */
export function setupNotificationsListener(config, db) {
  const ref = db.ref('notifications');
  const MAX_PENDING = 50;         // quá nhiều pending → spam, dọn cả queue
  const RATE_LIMIT_PER_MIN = 10;  // tối đa 10 forward mỗi phút
  let forwardedThisMinute = 0;
  let minuteWindowStart = Date.now();

  ref.on('child_added', async (snapshot) => {
    const payload = snapshot.val();
    try { await snapshot.ref.remove(); } catch (e) { /* ignore */ }
    if (!payload) return;

    // Rate limit (single-process, đủ cho agent 1 user)
    const now = Date.now();
    if (now - minuteWindowStart > 60_000) {
      minuteWindowStart = now;
      forwardedThisMinute = 0;
    }
    if (forwardedThisMinute >= RATE_LIMIT_PER_MIN) {
      console.warn(`${ts()} ⚠️ Notification rate limit — dropping payload`);
      return;
    }
    forwardedThisMinute++;

    // Render an toàn: nếu có structured fields → build từ các field đã
    // escape; nếu chỉ có text → escape toàn bộ text (text là untrusted).
    let text;
    if (payload.name || payload.email || payload.url) {
      const name = escapeTelegram(payload.name || 'Anonymous');
      const email = payload.email ? escapeTelegram(payload.email) : '';
      const url = payload.url ? escapeTelegram(payload.url) : '';
      const lines = ['✂️ <b>Yêu cầu mới!</b>'];
      if (name) lines.push(`Từ: ${name}${email ? ` (${email})` : ''}`);
      if (url) lines.push(`URL: ${url}`);
      if (payload.segments_count != null) lines.push(`Segments: ${payload.segments_count}`);
      if (payload.request_id) lines.push(`ID: <code>${escapeTelegram(payload.request_id)}</code>`);
      text = lines.join('\n');
    } else if (payload.text) {
      text = escapeTelegram(String(payload.text));
    } else {
      return;
    }

    await sendTelegramMessage(config, text);
  });

  // Anti-spam: nếu queue dồn > MAX_PENDING (bot chết/agent offline lâu),
  // dọn một nửa cũ nhất khi khởi động lại để không spam Telegram ồ ạt.
  setTimeout(async () => {
    try {
      const snap = await ref.once('value');
      const all = snap.val() || {};
      const keys = Object.keys(all);
      if (keys.length > MAX_PENDING) {
        const toDelete = keys.slice(0, keys.length - MAX_PENDING);
        for (const k of toDelete) {
          try { await ref.child(k).remove(); } catch (e) { /* ignore */ }
        }
        console.warn(`${ts()} ⚠️ Notification queue overflow — dropped ${toDelete.length} stale payloads`);
      }
    } catch (e) { /* ignore */ }
  }, 5000).unref();

  console.log(`${ts()} 👂 Notifications listener active on /notifications`);
  return ref;
}

