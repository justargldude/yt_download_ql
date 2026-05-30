// telegram.js — Gửi thông báo Telegram
import { ts } from './agent.js';

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
