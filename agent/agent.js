// agent.js — v3.0: Main agent loop + heartbeat + source registry + cancel
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { readFile, rm } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dns from 'dns';

// Fix slow/broken IPv6 lookup hang on Linux
dns.setDefaultResultOrder('ipv4first');

import { loadConfig } from './config-loader.js';
import { processRequest } from './processor.js';
import { startCleanupJob } from './cleanup.js';
import { sendTelegramMessage, setupNotificationsListener, escapeTelegram } from './telegram.js';
import { runStartupChecks } from './auth-checker.js';
import { startDlibUploadServer } from './dlib-upload-server.js';
import { ts } from './lib/logger.js';
import { normalizeUrlForDedup } from './lib/url-hash.js';
import { createDedupCoordinator } from './lib/dedup.js';

// Backwards-compat re-export: các module cũ import { ts } từ agent.js
export { ts };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── GLOBAL STATE ────────────────────────────────────────────────────────
let db = null;
let config = null;
let ytMode = 'cookies';                   // 'cookies' | 'browser' | 'none'
let isShuttingDown = false;               // drain mode: xử lý hết queue rồi tắt
let isForceShutdown = false;              // force quit ngay lập tức
let processingCount = 0;
let pollTimer = null;
let heartbeatTimer = null;
let currentRequestId = null;
let dlibUploadServer = null;
let isPolling = false;                    // mutex: ngăn nhiều poll chạy đồng thời
const processingSet = new Set();          // track requestId đang xử lý → skip duplicate
const processingUrls = new Map();         // track URL đang xử lý → defer duplicate URL
const dedup = createDedupCoordinator({ processingUrls });  // defer/chain same-video requests
let shutdownResolve = null;               // resolve khi drain xong
const MAX_RETRY_COUNT = 3;                // số lần retry tối đa trước khi đánh dấu error

// ── WAIT FOR NETWORK (boot-time DNS retry) ──────────────────────────────
async function waitForNetwork(maxRetries = 10, delayMs = 5000) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      await new Promise((resolve, reject) => {
        dns.resolve4('accounts.google.com', (err) => err ? reject(err) : resolve());
      });
      if (i > 1) console.log(`${ts()} ✅ Network ready (attempt ${i})`);
      return;
    } catch (err) {
      console.log(`${ts()} ⏳ Waiting for network... (attempt ${i}/${maxRetries}: ${err.code || err.message})`);
      if (i < maxRetries) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  console.warn(`${ts()} ⚠️ Network not fully ready after ${maxRetries} attempts, proceeding anyway...`);
}

// ── MAIN ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`${ts()} ========================================`);
  console.log(`${ts()} 🎬 YT-Queue Agent v3.0.0`);
  console.log(`${ts()} ========================================`);

  // 0. Wait for network (DNS) to be ready — important on boot
  await waitForNetwork();

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

  // 3. Kiểm tra quyền truy cập (YouTube cookies + Google Drive)
  const authResult = await runStartupChecks(config);
  ytMode = authResult.ytMode;

  // Ghi auth status lên Firebase để web UI hiển thị
  try {
    await db.ref('auth_status').set({
      youtube: ytMode,
      drive_ok: authResult.driveOk,
      drive_user: authResult.driveUser || null,
      drive_error: authResult.driveError || null,
      checked_at: new Date().toISOString(),
    });
  } catch (e) { /* ignore */ }

  // 4. Local endpoint cho PTIT DLib extension upload PDF lên Drive
  dlibUploadServer = await startDlibUploadServer(config);

  // 4. Khôi phục các request bị gián đoạn/kẹt
  await recoverInterruptedRequests();

  // 5. Telegram: thông báo agent đã khởi động
  const ytStatus = ytMode === 'cookies' ? '✅' : ytMode === 'browser' ? '🔄' : '❌';
  const driveStatus = authResult.driveOk ? '✅' : '❌';
  await sendTelegramMessage(config, `🟢 Agent started!\nYouTube: ${ytStatus} ${ytMode}\nDrive: ${driveStatus} ${authResult.driveUser || authResult.driveError || ''}`);

  // 5. Start heartbeat
  startHeartbeat();

  // 6. Start cleanup job
  startCleanupJob(config, db);

  // 7. Lắng nghe real-time qua Firebase listener
  setupRealtimeListener();

  // 7b. Consume hàng đợi notifications từ web client (chuyển tiếp Telegram)
  //     Web client không giữ bot token — token chỉ nằm trong config.json
  setupNotificationsListener(config, db);

  // 8. Main polling loop
  console.log(`${ts()} 🔄 Starting poll loop...`);
  pollTimer = setInterval(() => pollForRequests(), config.settings.pollIntervalMs);

  // Chạy poll đầu tiên ngay lập tức
  pollForRequests();

  // 9. Graceful shutdown (Ctrl+C lần 1 = drain, lần 2 = force)
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);


}

// ── RECOVER INTERRUPTED REQUESTS ────────────────────────────────────────
async function recoverInterruptedRequests() {
  try {
    const snapshot = await db.ref('requests').once('value');
    const requests = snapshot.val();
    if (!requests) return;

    console.log(`${ts()} 🔄 Checking for stuck or interrupted requests...`);
    let recoveredCount = 0;

    for (const [requestId, request] of Object.entries(requests)) {
      if (request.status === 'processing') {
        const retryCount = (request.retry_count || 0) + 1;
        if (retryCount >= MAX_RETRY_COUNT) {
          console.log(`${ts()} ❌ Request ${requestId} exceeded max retries (${MAX_RETRY_COUNT}) → marking as error`);
          await db.ref(`requests/${requestId}`).update({
            status: 'error',
            error_message: `Đã thử ${retryCount} lần nhưng vẫn thất bại. Vui lòng thử lại với link khác.`,
            failed_at: new Date().toISOString(),
            retry_count: retryCount,
          });
        } else {
          console.log(`${ts()} 🔄 Resetting interrupted request: ${requestId} (processing → pending, retry ${retryCount}/${MAX_RETRY_COUNT})`);
          await db.ref(`requests/${requestId}`).update({
            status: 'pending',
            progress: null,
            processing_started_at: null,
            retry_count: retryCount,
          });
        }
        recoveredCount++;
      } else if (request.status === 'cancelling') {
        console.log(`${ts()} 🔄 Resetting stuck cancelling request: ${requestId} (cancelling → cancelled)`);
        await db.ref(`requests/${requestId}`).update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
        });
        recoveredCount++;
      }
    }

    if (recoveredCount > 0) {
      console.log(`${ts()} ✅ Recovered/reset ${recoveredCount} request(s) on startup`);
    } else {
      console.log(`${ts()} 👍 No stuck requests found`);
    }
  } catch (err) {
    console.error(`${ts()} ❌ Recovery error: ${err.message}`);
  }
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
    // Chỉ trigger poll nếu không đang poll VÀ không đang xử lý request nào
    if (!isPolling && processingCount === 0) {
      pollForRequests();
    }
  });

  console.log(`${ts()} 👂 Real-time listener active on /requests`);
}

// ── POLL FOR PENDING REQUESTS ───────────────────────────────────────────
async function pollForRequests() {
  if (isForceShutdown) return;
  if (isPolling) return;   // mutex: skip nếu đang poll
  isPolling = true;

  try {
    const snapshot = await db
      .ref('requests')
      .orderByChild('status')
      .equalTo('pending')
      .once('value');

    const requests = snapshot.val();
    if (!requests) {
      // Nếu đang drain mode và không còn request pending → drain xong
      if (isShuttingDown && processingCount === 0 && shutdownResolve) {
        shutdownResolve();
        shutdownResolve = null;
      }
      return;
    }

    // Lọc bỏ requests đang xử lý (tránh pick duplicate)
    const entries = Object.entries(requests).filter(
      ([id]) => !processingSet.has(id)
    );
    if (entries.length === 0) {
      if (isShuttingDown && processingCount === 0 && shutdownResolve) {
        shutdownResolve();
        shutdownResolve = null;
      }
      return;
    }

    console.log(`${ts()} 📋 Found ${entries.length} pending request(s)`);

    for (const [requestId, request] of entries) {
      if (isForceShutdown) break;
      if (processingSet.has(requestId)) continue;  // double-check
      await handleSingleRequest(requestId, request);
    }

    // Xử lý các request bị defer vì trùng URL (request trước đã xong →
    // giờ source cache sẵn, xử lý rẻ). Retry từng URL đã hết bận.
    await drainDeferredRequests();

    // Sau khi xử lý xong tất cả entries trong drain mode → drain xong
    if (isShuttingDown && processingCount === 0 && shutdownResolve) {
      shutdownResolve();
      shutdownResolve = null;
    }
  } catch (err) {
    console.error(`${ts()} ❌ Poll error: ${err.message}`);
  } finally {
    isPolling = false;
  }
}

// ── DRAIN DEFERRED (trùng URL) REQUESTS ─────────────────────────────────
// Sau mỗi poll: các request đã defer vì trùng video sẽ được xử lý khi
// URL không còn bận. Read lại request từ DB để bắt status mới nhất (user
// có thể đã cancel trong lúc chờ).
async function drainDeferredRequests() {
  // Quét mọi URL có hàng chờ defer; URL còn bận sẽ chờ poll sau.
  for (const normalizedUrl of dedup.listDeferredUrls()) {
    if (isForceShutdown) return;
    if (dedup.isProcessing(normalizedUrl)) continue;  // vẫn bận

    let requestId;
    while ((requestId = dedup.takeDeferred(normalizedUrl)) !== null) {
      if (isForceShutdown) return;
      if (processingSet.has(requestId)) continue;

      // Đọc lại request mới nhất từ DB (bắt cancel trong lúc chờ)
      let request = null;
      try {
        const snap = await db.ref(`requests/${requestId}`).once('value');
        request = snap.val();
      } catch (e) { /* skip */ }
      if (!request || request.status !== 'pending') continue;  // cancelled/done rồi

      console.log(`${ts()} 🔁 Processing deferred request: ${requestId}`);
      await handleSingleRequest(requestId, request);

      // Nếu request này đã chiếm URL → các deferred còn lại chờ poll sau
      if (dedup.isProcessing(normalizedUrl)) break;
    }
  }
}

// ── HANDLE ONE REQUEST ──────────────────────────────────────────────────
async function handleSingleRequest(requestId, request) {
  // Guard: skip nếu request đã đang xử lý
  if (processingSet.has(requestId)) return;

  // Guard: skip nếu URL này đã đang được xử lý bởi request khác
  const normalizedUrl = normalizeUrlForDedup(request.url);
  if (normalizedUrl && dedup.isProcessing(normalizedUrl)) {
    // URL đang được xử lý bởi request khác → DEFER (không fail!).
    // Processor's downloadLocks + source cache sẽ xử lý request này
    // rẻ hơn nhiều khi request hiện tại xong (reuse cache, không tải lại).
    console.log(`${ts()} ⏳ Duplicate URL: ${requestId} cùng video với request đang xử lý → defer, sẽ xử lý ở poll sau`);
    dedup.defer(requestId, normalizedUrl);
    try {
      await db.ref(`requests/${requestId}/progress`).set({
        step: 'downloading', step_num: 1, total_steps: 3, percent: 0,
        segment_range: '⏳ Cùng video đang được tải — request này sẽ tự chạy tiếp',
        updated_at: new Date().toISOString(),
      });
    } catch (e) { /* ignore */ }
    return;
  }

  processingSet.add(requestId);
  if (normalizedUrl) processingUrls.set(normalizedUrl, requestId);

  const reqRef = db.ref(`requests/${requestId}`);
  const name = request.name || 'Unknown';
  const url = request.url || '(no url)';
  const safeName = escapeTelegram(name);
  const safeUrl = escapeTelegram(url);

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
    await sendTelegramMessage(config, `⚙️ Processing request from <b>${safeName}</b>...\n🔗 ${safeUrl}`);

    // c. Xử lý chính
    const result = await processRequest(request, requestId, config, db, checkCancelled, ytMode);

    // d. Cập nhật Firebase: done
    await reqRef.update({
      status: 'done',
      result_links: result.resultLinks,
      highlight_count: result.highlightCount,
      total_size_mb: result.totalSizeMB,
      download_full: result.isFullDownload || false,
      is_live: result.isLive || false,
      processed_at: new Date().toISOString(),
    });

    // e. Register source cache in Firebase (để web hiện danh sách video đã tải)
    if (result.sourceInfo) {
      const si = result.sourceInfo;
      try {
        await db.ref(`sources/${si.hash}`).set({
          url: si.url,
          file_path: si.filePath,
          file_size_mb: si.fileSizeMB,
          title: request.url, // will be URL, good enough
          downloaded_at: new Date().toISOString(),
          request_id: requestId,
        });
        console.log(`${ts()} 💾 Source cached: ${si.hash} (${si.fileSizeMB} MB, giữ 12h)`);
      } catch (e) { /* ignore */ }
    }

    console.log(`${ts()} ✅ Request ${requestId} completed successfully`);

    // f. Telegram kết quả
    await sendTelegramMessage(
      config,
      `✅ Done! <b>${safeName}</b>\n` +
      `📹 ${result.highlightCount} highlight(s), ${result.totalSizeMB} MB\n` +
      `🔗 ${safeUrl}`
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
      await sendTelegramMessage(config, `🚫 Request cancelled & files cleaned: <b>${safeName}</b>\n🔗 ${safeUrl}`);
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
        `❌ Failed: <b>${safeName}</b>\n` +
        `Error: ${escapeTelegram(err.message.slice(0, 200))}\n` +
        `🔗 ${safeUrl}`
      );
    }
  } finally {
    processingCount--;
    currentRequestId = null;
    processingSet.delete(requestId);
    dedup.remove(requestId);  // purge khỏi deferred queues nếu user đã cancel
    if (normalizedUrl) processingUrls.delete(normalizedUrl);
  }
}

async function stopDlibUploadServer() {
  if (!dlibUploadServer) return;
  const server = dlibUploadServer;
  dlibUploadServer = null;
  await new Promise((resolve) => server.close(resolve));
}

// ── NORMALIZE URL FOR DEDUP ─────────────────────────────────────────────
// (Đã chuyển vào lib/url-hash.js — giữ alias nội bộ)

// ── GRACEFUL SHUTDOWN ───────────────────────────────────────────────────
async function handleShutdown() {
  // Lần 2: force quit ngay
  if (isShuttingDown) {
    isForceShutdown = true;
    console.log(`\n${ts()} ⚡ Force shutdown! Exiting immediately...`);
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    await stopDlibUploadServer();
    try {
      await db.ref('agent_status').set({
        online: false, last_heartbeat: new Date().toISOString(),
        processing: null, version: '3.0.0',
      });
    } catch (e) { /* ignore */ }
    await sendTelegramMessage(config, '🔴 Agent force-stopped.');
    console.log(`${ts()} 👋 Force stopped. Goodbye!`);
    process.exit(1);
    return;
  }

  // Lần 1: drain mode — xử lý hết queue rồi tắt
  isShuttingDown = true;

  console.log(`\n${ts()} 🛑 Drain mode: finishing current + remaining pending requests...`);
  console.log(`${ts()} 💡 Press Ctrl+C again to force quit immediately.`);

  // Dừng polling interval — ta sẽ chạy 1 poll cuối thủ công
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

  // Giữ heartbeat chạy trong drain mode

  // Nếu đang có request processing → chờ nó xong
  if (processingCount > 0) {
    console.log(`${ts()} ⏳ Waiting for ${processingCount} in-progress request(s)...`);
    while (processingCount > 0 && !isForceShutdown) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (isForceShutdown) return;

  // Chờ poll đang chạy (nếu có) hoàn thành trước
  while (isPolling && !isForceShutdown) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (isForceShutdown) return;

  // Chạy 1 poll cuối để xử lý hết pending requests còn lại
  console.log(`${ts()} 🔄 Draining remaining pending requests...`);
  const drainDone = new Promise((resolve) => { shutdownResolve = resolve; });

  // Poll 1 lần cuối — pollForRequests sẽ xử lý tuần tự hết entries
  await pollForRequests();

  // Nếu poll đã xong ngay (không còn pending) thì shutdownResolve đã được gọi
  // Nếu chưa → chờ
  if (shutdownResolve) {
    // Vẫn còn đang xử lý → chờ drain xong (không giới hạn thời gian)
    await drainDone;
  }

  if (isForceShutdown) return;

  // Dọn dẹp
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  await stopDlibUploadServer();

  try {
    await db.ref('agent_status').set({
      online: false,
      last_heartbeat: new Date().toISOString(),
      processing: null,
      version: '3.0.0',
    });
  } catch (e) { /* ignore */ }

  await sendTelegramMessage(config, '🔴 Agent stopped (drain complete).');

  console.log(`${ts()} ✅ All pending requests processed!`);
  console.log(`${ts()} 👋 Agent stopped. Goodbye!`);
  process.exit(0);
}

// ── START ───────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error(`${ts()} 💀 Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
