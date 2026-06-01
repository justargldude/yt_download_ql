// agent.js — v3.0: Main agent loop + heartbeat + source registry + cancel
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { readFile, rm } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

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

// ── URL HASH (strip tracking params) ────────────────────────────────────
function hashUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('si');
    u.searchParams.delete('t');
    u.searchParams.delete('feature');
    const clean = u.origin + u.pathname + '?v=' + (u.searchParams.get('v') || '');
    return crypto.createHash('md5').update(clean).digest('hex').slice(0, 12);
  } catch {
    return crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
  }
}

// ── GLOBAL STATE ────────────────────────────────────────────────────────
let db = null;
let config = null;
let isShuttingDown = false;
let processingCount = 0;
let pollTimer = null;
let heartbeatTimer = null;
let currentRequestId = null;

// ── MAIN ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`${ts()} ========================================`);
  console.log(`${ts()} 🎬 YT-Queue Agent v3.0.0`);
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
  await sendTelegramMessage(config, '🟢 Agent v3.0 started! Listening for requests...');

  // 4. Start heartbeat
  startHeartbeat();

  // 5. Start cleanup job
  startCleanupJob(config, db);

  // 6. Lắng nghe real-time qua Firebase listener
  setupRealtimeListener();

  // 7. Main polling loop
  console.log(`${ts()} 🔄 Starting poll loop...`);
  pollTimer = setInterval(() => pollForRequests(), config.settings.pollIntervalMs);

  // Chạy poll đầu tiên ngay lập tức
  pollForRequests();

  // 8. Graceful shutdown
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);
}

// ── HEARTBEAT ───────────────────────────────────────────────────────────
function startHeartbeat() {
  const writeHeartbeat = async () => {
    try {
      await db.ref('agent_status').set({
        online: true,
        last_heartbeat: new Date().toISOString(),
        processing: currentRequestId || null,
        version: '3.0.0',
      });
    } catch (e) {
      console.warn(`${ts()} ⚠️ Heartbeat write failed: ${e.message}`);
    }
  };

  // Ghi ngay lập tức
  writeHeartbeat();

  // Lặp mỗi 15 giây
  heartbeatTimer = setInterval(writeHeartbeat, 15000);
  heartbeatTimer.unref();

  console.log(`${ts()} 💚 Heartbeat started (every 15s)`);
}

// ── FIREBASE REAL-TIME LISTENER ─────────────────────────────────────────
function setupRealtimeListener() {
  const ref = db.ref('requests');

  ref.orderByChild('status').equalTo('pending').on('child_added', (snapshot) => {
    const key = snapshot.key;
    console.log(`${ts()} 🔔 Real-time: new pending request detected → ${key}`);
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
  currentRequestId = requestId;

  // Cancel check function
  const checkCancelled = async () => {
    try {
      const snap = await db.ref(`requests/${requestId}/status`).once('value');
      return snap.val() === 'cancelling';
    } catch { return false; }
  };

  try {
    // a. Đánh dấu đang xử lý
    await reqRef.update({
      status: 'processing',
      processing_started_at: new Date().toISOString(),
    });

    // b. Telegram thông báo
    await sendTelegramMessage(config, `⚙️ Processing request from <b>${name}</b>...\n🔗 ${url}`);

    // c. Xử lý chính
    const result = await processRequest(request, requestId, config, db, checkCancelled);

    // d. Cập nhật Firebase: done
    await reqRef.update({
      status: 'done',
      result_links: result.resultLinks,
      highlight_count: result.highlightCount,
      total_size_mb: result.totalSizeMB,
      processed_at: new Date().toISOString(),
    });

    console.log(`${ts()} ✅ Request ${requestId} completed successfully`);

    // f. Telegram kết quả
    await sendTelegramMessage(
      config,
      `✅ Done! <b>${name}</b>\n` +
      `📹 ${result.highlightCount} highlight(s), ${result.totalSizeMB} MB\n` +
      `🔗 ${url}`
    );
  } catch (err) {
    // Xử lý cancel
    if (err.message === 'CANCELLED') {
      console.log(`${ts()} 🚫 Request ${requestId} cancelled by user`);
      // Clean up partial downloads
      const outputDir = path.join(config.paths.outputDir, requestId);
      try {
        await rm(outputDir, { recursive: true, force: true });
        console.log(`${ts()} 🗑️  Cleaned up partial files: ${outputDir}`);
      } catch (cleanErr) {
        console.warn(`${ts()} ⚠️ Cleanup failed: ${cleanErr.message}`);
      }
      try {
        await reqRef.update({ status: 'cancelled', cancelled_at: new Date().toISOString() });
      } catch (e) { /* ignore */ }
      await sendTelegramMessage(config, `🚫 Request cancelled & files cleaned: <b>${name}</b>\n🔗 ${url}`);
    } else {
      console.error(`${ts()} ❌ Request ${requestId} failed: ${err.message}`);

      try {
        await reqRef.update({
          status: 'error',
          error_message: err.message,
          failed_at: new Date().toISOString(),
        });
      } catch (dbErr) {
        console.error(`${ts()} ❌ Failed to update error status: ${dbErr.message}`);
      }

      await sendTelegramMessage(
        config,
        `❌ Failed: <b>${name}</b>\n` +
        `Error: ${err.message.slice(0, 200)}\n` +
        `🔗 ${url}`
      );
    }
  } finally {
    processingCount--;
    currentRequestId = null;
  }
}

// ── GRACEFUL SHUTDOWN ───────────────────────────────────────────────────
async function handleShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n${ts()} 🛑 Shutting down gracefully...`);

  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

  if (processingCount > 0) {
    console.log(`${ts()} ⏳ Waiting for ${processingCount} request(s) to finish...`);
    const deadline = Date.now() + 30000;
    while (processingCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Set agent offline
  try {
    await db.ref('agent_status').set({
      online: false,
      last_heartbeat: new Date().toISOString(),
      processing: null,
      version: '3.0.0',
    });
  } catch (e) { /* ignore */ }

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
