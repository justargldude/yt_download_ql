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
 * sang Telegram rồi xoá khỏi queue. Payload đã render sẵn HTML an toàn
 * phía client, nhưng agent vẫn escape lại mọi trường user-controlled
 * (defense in depth).
 *
 * @param {object} config - App config (telegram credentials)
 * @param {object} db - firebase-admin Database instance
 */
export function setupNotificationsListener(config, db) {
  const ref = db.ref('notifications');

  ref.on('child_added', async (snapshot) => {
    const payload = snapshot.val();
    if (!payload || !payload.text) {
      try { await snapshot.ref.remove(); } catch (e) { /* ignore */ }
      return;
    }

    // Defense-in-depth: escape lại user-controlled fields nếu client
    // gửi dạng structured. Payload.text đã được client escape, ta chỉ
    // escape thêm nếu có các field riêng lẻ kèm theo.
    let text = String(payload.text);
    if (payload.name) {
      // Nếu client gửi kèm name/email/url thô, ưu tiên render có escape
      const name = escapeTelegram(payload.name);
      const email = payload.email ? escapeTelegram(payload.email) : '';
      const url = payload.url ? escapeTelegram(payload.url) : '';
      const lines = ['✂️ <b>Yêu cầu mới!</b>'];
      if (name) lines.push(`Từ: ${name}${email ? ` (${email})` : ''}`);
      if (url) lines.push(`URL: ${url}`);
      if (payload.segments_count != null) lines.push(`Segments: ${payload.segments_count}`);
      if (payload.request_id) lines.push(`ID: <code>${escapeTelegram(payload.request_id)}</code>`);
      text = lines.join('\n');
    }

    await sendTelegramMessage(config, text);

    // Xoá khỏi queue sau khi đã chuyển tiếp (at-least-once semantics)
    try { await snapshot.ref.remove(); } catch (e) {
      console.warn(`${ts()} ⚠️ Notification remove failed: ${e.message}`);
    }
  });

  console.log(`${ts()} 👂 Notifications listener active on /notifications`);
  return ref;
}

