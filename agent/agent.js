// agent.js — Main agent loop: poll Firebase, xử lý request, thông báo Telegram
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config-loader.js';
import { processRequest } from './processor.js';
import { startCleanupJob } from './cleanup.js';
import { sendTelegramMessage } from './telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── TIMESTAMP HELPER (export cho các module khác dùng) ──────────────────
export function ts() {
  const now = new Date();
  return `[${now.toTimeString().slice(0, 8)}]`;
}

// ── GLOBAL STATE ────────────────────────────────────────────────────────
let db = null;
let config = null;
let isShuttingDown = false;
let processingCount = 0;
let pollTimer = null;

// ── MAIN ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`${ts()} ========================================`);
  console.log(`${ts()} 🎬 YT-Queue Agent v2.0.0`);
  console.log(`${ts()} ========================================`);

  // 1. Load config
  config = await loadConfig();
  console.log(`${ts()} ✅ Config loaded`);
  console.log(`${ts()} 📂 Output dir: ${config.paths.outputDir}`);
  console.log(`${ts()} ⏱️  Poll interval: ${config.settings.pollIntervalMs / 1000}s`);

  // 2. Initialize Firebase Admin
  const saPath = path.resolve(__dirname, config.firebase.serviceAccountPath);
  const saRaw = await readFile(saPath, 'utf-8');
  const serviceAccount = JSON.parse(saRaw);

  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: config.firebase.databaseURL,
  });

  db = getDatabase();
  console.log(`${ts()} ✅ Firebase connected: ${config.firebase.databaseURL}`);

  // 3. Telegram: thông báo agent đã khởi động
  await sendTelegramMessage(config, '🟢 Agent started! Listening for requests...');

  // 4. Start cleanup job
  startCleanupJob(config);

  // 5. Lắng nghe real-time qua Firebase listener (bổ sung cho polling)
  setupRealtimeListener();

  // 6. Main polling loop
  console.log(`${ts()} 🔄 Starting poll loop...`);
  pollTimer = setInterval(() => pollForRequests(), config.settings.pollIntervalMs);

  // Chạy poll đầu tiên ngay lập tức
  pollForRequests();

  // 7. Graceful shutdown
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);
}

// ── FIREBASE REAL-TIME LISTENER ─────────────────────────────────────────
function setupRealtimeListener() {
  const ref = db.ref('requests');

  ref.orderByChild('status').equalTo('pending').on('child_added', (snapshot) => {
    const key = snapshot.key;
    console.log(`${ts()} 🔔 Real-time: new pending request detected → ${key}`);
    // Không xử lý trực tiếp ở đây, để poll loop xử lý để tránh race condition
    // Nhưng trigger poll ngay nếu đang idle
    if (processingCount === 0) {
      pollForRequests();
    }
  });

  console.log(`${ts()} 👂 Real-time listener active on /requests`);
}

// ── POLL FOR PENDING REQUESTS ───────────────────────────────────────────
async function pollForRequests() {
  if (isShuttingDown) return;

  try {
    const snapshot = await db
      .ref('requests')
      .orderByChild('status')
      .equalTo('pending')
      .once('value');

    const requests = snapshot.val();
    if (!requests) return;

    const entries = Object.entries(requests);
    console.log(`${ts()} 📋 Found ${entries.length} pending request(s)`);

    for (const [requestId, request] of entries) {
      if (isShuttingDown) break;
      await handleSingleRequest(requestId, request);
    }
  } catch (err) {
    console.error(`${ts()} ❌ Poll error: ${err.message}`);
  }
}

// ── HANDLE ONE REQUEST ──────────────────────────────────────────────────
async function handleSingleRequest(requestId, request) {
  const reqRef = db.ref(`requests/${requestId}`);
  const name = request.name || 'Unknown';
  const url = request.url || '(no url)';

  console.log(`${ts()} ─────────────────────────────────────────`);
  console.log(`${ts()} 🆕 Processing: ${requestId}`);
  console.log(`${ts()} 👤 From: ${name} | 🔗 URL: ${url}`);
  console.log(`${ts()} ─────────────────────────────────────────`);

  processingCount++;

  try {
    // a. Đánh dấu đang xử lý
    await reqRef.update({
      status: 'processing',
      processing_started_at: new Date().toISOString(),
    });

    // b. Telegram thông báo
    await sendTelegramMessage(config, `⚙️ Processing request from <b>${name}</b>...\n🔗 ${url}`);

    // c. Xử lý chính
    const result = await processRequest(request, requestId, config);

    // d. Cập nhật Firebase: done
    await reqRef.update({
      status: 'done',
      result_links: result.resultLinks,
      highlight_count: result.highlightCount,
      total_size_mb: result.totalSizeMB,
      processed_at: new Date().toISOString(),
    });

    console.log(`${ts()} ✅ Request ${requestId} completed successfully`);

    // e. Telegram kết quả
    await sendTelegramMessage(
      config,
      `✅ Done! <b>${name}</b>\n` +
      `📹 ${result.highlightCount} highlight(s), ${result.totalSizeMB} MB\n` +
      `🔗 ${url}`
    );
  } catch (err) {
    console.error(`${ts()} ❌ Request ${requestId} failed: ${err.message}`);

    // Cập nhật Firebase: error
    try {
      await reqRef.update({
        status: 'error',
        error_message: err.message,
        failed_at: new Date().toISOString(),
      });
    } catch (dbErr) {
      console.error(`${ts()} ❌ Failed to update error status: ${dbErr.message}`);
    }

    // Telegram lỗi
    await sendTelegramMessage(
      config,
      `❌ Failed: <b>${name}</b>\n` +
      `Error: ${err.message.slice(0, 200)}\n` +
      `🔗 ${url}`
    );
  } finally {
    processingCount--;
  }
}

// ── GRACEFUL SHUTDOWN ───────────────────────────────────────────────────
async function handleShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n${ts()} 🛑 Shutting down gracefully...`);

  // Dừng poll
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // Đợi request đang xử lý (tối đa 30s)
  if (processingCount > 0) {
    console.log(`${ts()} ⏳ Waiting for ${processingCount} request(s) to finish...`);
    const deadline = Date.now() + 30000;
    while (processingCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Telegram thông báo tắt
  await sendTelegramMessage(config, '🔴 Agent stopped.');

  console.log(`${ts()} 👋 Agent stopped. Goodbye!`);
  process.exit(0);
}

// ── START ───────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error(`${ts()} 💀 Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
