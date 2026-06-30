// processor.js — v4.3: Source caching (giữ source 12h, xoá highlight sau email)
// Flow:
//   1. Check source cache (sources/{urlHash}/source.mp4)
//   2. Download nếu chưa có
//   3. ffmpeg cut → req_{id}/HL_xxx.mp4
//   4. Upload + email
//   5. Xoá highlights, giữ source 12h
import { spawn } from 'child_process';
import { mkdir, stat, unlink, readdir, rm, writeFile } from 'fs/promises';
import { existsSync, createReadStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ts } from './agent.js';
import { sendResultEmail } from './emailer.js';
import { uploadToGoogleDrive } from './uploader.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Download lock per URL hash — chỉ tải 1 lần dù nhiều request cùng URL
const downloadLocks = new Map();  // urlHash → Promise<void>

// ── URL HASH ────────────────────────────────────────────────────────────
function hashUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('si');
    u.searchParams.delete('t');
    u.searchParams.delete('feature');
    // Lấy video ID cho YouTube
    const videoId = u.searchParams.get('v') || u.pathname.split('/').pop();
    const clean = `youtube:${videoId}`;
    return crypto.createHash('md5').update(clean).digest('hex').slice(0, 12);
  } catch {
    return crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
  }
}

// ── HELPERS ──────────────────────────────────────────────────────────────
function timeTag(timestamp) {
  if (!timestamp) return 'unknown';
  const parts = timestamp.split(':').map(Number);
  if (parts.length === 3) {
    const [h, m, s] = parts;
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
    return `${m}m${String(s).padStart(2, '0')}s`;
  }
  if (parts.length === 2) return `${parts[0]}m${String(parts[1]).padStart(2, '0')}s`;
  return timestamp.replace(/:/g, '-');
}

// ── PROGRESS WRITER ─────────────────────────────────────────────────────
function createProgressWriter(db, requestId) {
  let lastWrite = 0, pending = null, flushTimer = null;
  async function write(obj) {
    const now = Date.now();
    obj.updated_at = new Date().toISOString();
    pending = obj;
    if (now - lastWrite >= 2000) {
      lastWrite = now;
      try { await db.ref(`requests/${requestId}/progress`).set(pending); } catch (e) {}
      pending = null;
    } else if (!flushTimer) {
      flushTimer = setTimeout(async () => {
        flushTimer = null;
        if (pending) { lastWrite = Date.now(); try { await db.ref(`requests/${requestId}/progress`).set(pending); } catch (e) {} pending = null; }
      }, 2000 - (now - lastWrite));
    }
  }
  async function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pending) { try { await db.ref(`requests/${requestId}/progress`).set(pending); } catch (e) {} pending = null; }
  }
  return { write, flush };
}

// ── PARSE PROGRESS ──────────────────────────────────────────────────────
function parseProgressLine(line) {
  let m = line.match(/(\d+(?:\.\d+)?)([MKG]i?B)\/([.\d]+)([MKG]i?B)\((\d+)%\).*DL:([\d.]+)([MKG]i?B).*ETA:(\S+)/i);
  if (m) return { downloaded: `${m[1]} ${m[2]}`, total_size: `${m[3]} ${m[4]}`, percent: parseFloat(m[5]), speed: `${m[6]} ${m[7]}/s`, eta: m[8].replace(/]/g, '') };
  m = line.match(/(\d+\.?\d*)%\s+of\s+~?([\d.]+\s*\S+)\s+at\s+([\d.]+\s*\S+)\s+ETA\s+(\S+)/);
  if (m) return { percent: parseFloat(m[1]), total_size: m[2], speed: m[3], eta: m[4] };
  m = line.match(/(\d+\.?\d*)%\s+of\s+~?([\d.]+\s*\S+)\s+in\s+(\S+)/);
  if (m) return { percent: parseFloat(m[1]), total_size: m[2], downloaded: m[2], speed: null, eta: null };
  return null;
}

// ── SPAWN ───────────────────────────────────────────────────────────────
function spawnAsync(cmd, args, { prefix = '', cwd, onLine, onProc } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderrBuf = '';
    if (onProc) onProc(proc);
    const handle = (chunk) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        console.log(`${ts()} ${prefix} ${line}`);
        if (onLine) onLine(line);
      }
    };
    if (proc.stdout) proc.stdout.on('data', handle);
    if (proc.stderr) proc.stderr.on('data', (c) => { stderrBuf += c.toString(); handle(c); });
    proc.on('error', (err) => reject(new Error(`Failed to spawn ${cmd}: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve({ code, stderr: stderrBuf });
      else reject(new Error(`${cmd} exited with code ${code}.\n${stderrBuf.slice(-500)}`));
    });
  });
}

function killProcessTree(proc) {
  if (!proc || !proc.pid) return;
  try { process.kill(-proc.pid, 'SIGTERM'); }
  catch (e) { try { proc.kill('SIGKILL'); } catch (e2) {} }
}

// ═════════════════════════════════════════════════════════════════════════
export async function processRequest(request, requestId, config, db, checkCancelled, ytMode = 'cookies') {
  const outputDir = path.join(config.paths.outputDir, requestId);
  const sourcesDir = path.join(config.paths.outputDir, 'sources');
  let currentProc = null;
  const pw = createProgressWriter(db, requestId);

  async function assertNotCancelled() {
    if (await checkCancelled()) {
      if (currentProc) killProcessTree(currentProc);
      throw new Error('CANCELLED');
    }
  }

  await mkdir(outputDir, { recursive: true });
  await mkdir(sourcesDir, { recursive: true });

  const segments = request.segments || [];
  const isFullDownload = segments.length === 0 || request.download_full === true;

  const ffmpegDir = path.dirname(config.paths.ffmpeg);
  const ytdlpDir = path.dirname(config.paths.ytdlp);
  const aria2cPath = path.join(ytdlpDir, 'aria2c');
  const useAria2c = existsSync(aria2cPath);
  const cookiesFile = config.paths.cookiesFile;
  const totalSegments = segments.length;
  const datePart = (request.created_at || new Date().toISOString()).split('T')[0].replace(/-/g, '');

  // Detect live stream từ URL pattern
  const isLiveUrl = /\/live\//i.test(request.url) || /[?&]live=/i.test(request.url);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: DOWNLOAD (hoặc reuse source cache)
  // ═══════════════════════════════════════════════════════════════════════
  const urlHash = hashUrl(request.url);
  const sourceDir = path.join(sourcesDir, urlHash);
  const sourcePath = path.join(sourceDir, 'source.mp4');
  let sourceReused = false;

  await mkdir(sourceDir, { recursive: true });

  if (existsSync(sourcePath)) {
    // ── SOURCE CÓ SẴN → skip download ──
    const info = await stat(sourcePath);
    const sizeMB = (info.size / 1024 / 1024).toFixed(0);
    console.log(`${ts()} ════════════════════════════════════════`);
    console.log(`${ts()} ♻️  Source cached! Skip download (${sizeMB} MB)`);
    console.log(`${ts()} 📂 ${sourcePath}`);
    console.log(`${ts()} ════════════════════════════════════════`);

    await pw.write({
      step: 'downloading', step_num: 1, total_steps: isFullDownload ? 2 : 3, percent: 100,
      current_file: 'Dùng source cache', segment_range: `♻️ Đã tải trước — skip download!`,
    });
    sourceReused = true;
  } else if (downloadLocks.has(urlHash)) {
    // ── ĐANG CÓ REQUEST KHÁC TẢI CÙNG URL → chờ ──
    console.log(`${ts()} ════════════════════════════════════════`);
    console.log(`${ts()} ⏳ Another request is downloading this video, waiting...`);
    console.log(`${ts()} 🔗 ${request.url}`);
    console.log(`${ts()} ════════════════════════════════════════`);

    await pw.write({
      step: 'downloading', step_num: 1, total_steps: isFullDownload ? 2 : 3, percent: 0,
      current_file: 'Chờ download từ request khác...', segment_range: `⏳ Cùng video đang được tải...`,
    });

    // Chờ download kia hoàn thành
    try {
      await downloadLocks.get(urlHash);
    } catch (e) {
      // Download kia lỗi — ta sẽ thử lại bên dưới
    }

    // Kiểm tra lại: nếu source đã có → dùng cache
    if (existsSync(sourcePath)) {
      const info = await stat(sourcePath);
      const sizeMB = (info.size / 1024 / 1024).toFixed(0);
      console.log(`${ts()} ♻️  Source now available after wait (${sizeMB} MB)`);
      await pw.write({
        step: 'downloading', step_num: 1, total_steps: isFullDownload ? 2 : 3, percent: 100,
        current_file: 'Dùng source cache', segment_range: `♻️ Download xong — dùng cache!`,
      });
      sourceReused = true;
    } else {
      // Download kia lỗi, ta tự tải lại
      console.log(`${ts()} ⚠️ Previous download failed, retrying ourselves...`);
      await doDownload();
    }
  } else {
    // ── DOWNLOAD MỚI ──
    await doDownload();
  }

  // Hàm download thực sự (tách ra để reuse)
  async function doDownload() {
    let lockResolve, lockReject;
    const lockPromise = new Promise((res, rej) => { lockResolve = res; lockReject = rej; });
    downloadLocks.set(urlHash, lockPromise);

    try {
      console.log(`${ts()} ════════════════════════════════════════`);
      console.log(`${ts()} 📥 Downloading video → ${sourceDir}`);
      console.log(`${ts()} 🔗 ${request.url}`);
      if (useAria2c) console.log(`${ts()} 🚀 aria2c accelerator active`);
      console.log(`${ts()} ════════════════════════════════════════`);

      const dlArgs = [
        '--force-ipv4',
        '--concurrent-fragments', String(config.settings?.concurrentFragments || 16),
        '--retries', '10', '--fragment-retries', '10',
        '--user-agent', UA,
        '-f', 'bv*+ba/b', '--merge-output-format', 'mp4',
        '--ffmpeg-location', ffmpegDir,
        '-o', sourcePath, '--no-playlist',
      ];
      // YouTube auth: dùng cookies file hoặc đọc từ browser
      if (ytMode === 'browser') {
        dlArgs.push('--cookies-from-browser', 'chrome');
      } else if (cookiesFile && existsSync(cookiesFile)) {
        dlArgs.push('--cookies', cookiesFile);
      }

      // Live stream: tải từ đầu, chờ nếu chưa bắt đầu, không giới hạn fragment
      if (isLiveUrl) {
        dlArgs.push('--live-from-start');
        dlArgs.push('--wait-for-video', '30-300');  // chờ 30s-5min nếu live chưa bắt đầu
        dlArgs.push('--no-part');  // không dùng .part file
        console.log(`${ts()} 🔴 Live stream detected — will download until stream ends`);
      }

      // aria2c không tương thích với live stream
      if (useAria2c && !isLiveUrl) {
        dlArgs.push('--downloader', 'aria2c');
        dlArgs.push('--downloader-args', 'aria2c:-x 16 -s 16 -j 16 -k 1M --allow-overwrite=true --auto-file-renaming=false');
      }
      dlArgs.push(request.url);

      const onDlLine = (line) => {
        const prog = parseProgressLine(line);
        if (prog) {
          pw.write({
            step: 'downloading', step_num: 1, total_steps: isFullDownload ? 2 : 3,
            percent: Math.round(prog.percent || 0),
            speed: prog.speed, eta: prog.eta,
            downloaded: prog.downloaded || null, total_size: prog.total_size || null,
            current_file: 'source.mp4',
            is_live: isLiveUrl,
            segment_range: isFullDownload
              ? (isLiveUrl ? '🔴 Đang tải live stream...' : 'Tải full video')
              : `Tải video → cắt ${totalSegments} đoạn`,
          });
        }
        // Live: parse fragment count nếu không match progress thông thường
        if (isLiveUrl && !prog) {
          const fragMatch = line.match(/frag\s*(\d+)/i);
          if (fragMatch) {
            pw.write({
              step: 'downloading', step_num: 1, total_steps: isFullDownload ? 2 : 3,
              percent: 0,
              current_file: `fragment ${fragMatch[1]}`,
              is_live: true,
              segment_range: '🔴 Đang tải live stream...',
            });
          }
        }
      };

      let dlCancelled = false;
      const cancelCheck = setInterval(async () => {
        try { if (await checkCancelled()) { dlCancelled = true; if (currentProc) killProcessTree(currentProc); } } catch (e) {}
      }, 3000);

      try {
        await spawnAsync(config.paths.ytdlp, dlArgs, {
          prefix: '[yt-dlp]', cwd: sourceDir, onLine: onDlLine,
          onProc: (p) => { currentProc = p; }
        });
      } catch (err) {
        if (dlCancelled || await checkCancelled()) { clearInterval(cancelCheck); lockReject(err); throw new Error('CANCELLED'); }
        // Retry without aria2c
        if (useAria2c) {
          console.log(`${ts()} ⚠️ aria2c failed, retrying native...`);
          const retry = [];
          for (let j = 0; j < dlArgs.length; j++) {
            if (dlArgs[j] === '--downloader' || dlArgs[j] === '--downloader-args') {
              j++; // skip flag + its value
              continue;
            }
            retry.push(dlArgs[j]);
          }
          await assertNotCancelled();
          try { await spawnAsync(config.paths.ytdlp, retry, { prefix: '[retry]', cwd: sourceDir, onLine: onDlLine, onProc: (p) => { currentProc = p; } }); }
          catch (e2) { if (dlCancelled || await checkCancelled()) { clearInterval(cancelCheck); lockReject(e2); throw new Error('CANCELLED'); } lockReject(e2); throw e2; }
        } else { lockReject(err); throw err; }
      } finally { clearInterval(cancelCheck); }
      currentProc = null;

      lockResolve();  // Thông báo cho các request khác biết download xong
    } catch (err) {
      // Đảm bảo lock luôn được resolve/reject
      try { lockReject(err); } catch (e) {}
      throw err;
    } finally {
      downloadLocks.delete(urlHash);
    }
  }

  // Find actual source file
  let actualSource = sourcePath;
  if (!existsSync(sourcePath)) {
    const files = await readdir(sourceDir);
    const mp4 = files.find(f => f.endsWith('.mp4') && !f.startsWith('HL_'));
    if (mp4) actualSource = path.join(sourceDir, mp4);
    else throw new Error('Source file not found.');
  }

  const sourceInfo = await stat(actualSource);
  const sourceSizeMB = (sourceInfo.size / 1024 / 1024).toFixed(0);
  if (!sourceReused) console.log(`${ts()} ✅ Download complete: ${sourceSizeMB} MB`);

  // Save source metadata
  const metaPath = path.join(sourceDir, '_meta.json');
  try {
    await writeFile(metaPath, JSON.stringify({
      url: request.url,
      hash: urlHash,
      downloaded_at: sourceReused ? (existsSync(metaPath) ? JSON.parse(await readFileText(metaPath)).downloaded_at : new Date().toISOString()) : new Date().toISOString(),
      file_size_mb: parseInt(sourceSizeMB),
    }), 'utf-8');
  } catch (e) { /* ignore */ }

  const totalSteps = isFullDownload ? 2 : 3;
  let filesToUpload = [];

  if (isFullDownload) {
    // ═══════════════════════════════════════════════════════════════════════
    // FULL DOWNLOAD — skip cut, dùng source trực tiếp
    // ═══════════════════════════════════════════════════════════════════════
    console.log(`${ts()} 📦 Full download mode — skipping cut step`);
    await pw.write({ step: 'downloading', step_num: 1, total_steps: totalSteps, percent: 100, segment_range: 'Tải xong!' });
    filesToUpload = [actualSource];
  } else {
    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1b: CUT SEGMENTS
    // ═══════════════════════════════════════════════════════════════════════
    await pw.write({ step: 'downloading', step_num: 1, total_steps: totalSteps, percent: 100, segment_range: 'Đang cắt...' });
    console.log(`${ts()} ✂️  Cutting ${totalSegments} segment(s)...`);
    const highlightFiles = [];

    for (let i = 0; i < totalSegments; i++) {
      await assertNotCancelled();
      const seg = segments[i];
      const hlName = `HL_${datePart}_${timeTag(seg.start)}-${timeTag(seg.end)}.mp4`;
      const hlPath = path.join(outputDir, hlName);

      console.log(`${ts()} ✂️  [${i + 1}/${totalSegments}] ${seg.start} → ${seg.end} → ${hlName}`);

      try {
        await spawnAsync(config.paths.ffmpeg, [
          '-y', '-loglevel', 'error', '-ss', seg.start, '-to', seg.end,
          '-i', actualSource, '-c', 'copy', '-avoid_negative_ts', 'make_zero',
          '-movflags', '+faststart', hlPath,
        ], { prefix: `[cut ${i + 1}]`, cwd: outputDir, onProc: (p) => { currentProc = p; } });
      } catch (err) {
        console.error(`${ts()} ❌ Cut failed [${i + 1}]: ${err.message}`);
        continue;
      }
      currentProc = null;
      if (existsSync(hlPath)) highlightFiles.push(hlPath);
    }

    console.log(`${ts()} ✅ Cut: ${highlightFiles.length}/${totalSegments}`);
    if (highlightFiles.length === 0) throw new Error('No highlights produced.');
    filesToUpload = highlightFiles;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: UPLOAD
  // ═══════════════════════════════════════════════════════════════════════
  await assertNotCancelled();
  let totalSize = 0;
  for (const fp of filesToUpload) totalSize += (await stat(fp)).size;
  const totalSizeMB = totalSize / (1024 * 1024);
  const maxEmailMB = config.settings?.maxFileSizeForEmailMB || 25;
  console.log(`${ts()} 📊 Total: ${totalSizeMB.toFixed(1)} MB`);

  let driveLinks = [], resultLinks = [], driveUploadOk = false;

  if (config.google_drive?.folderId && (config.google_drive?.clientId || config.google_drive?.serviceAccountPath)) {
    console.log(`${ts()} ☁️  Uploading ${filesToUpload.length} file(s) to Drive...`);
    await pw.write({ step: 'uploading', step_num: 2, total_steps: totalSteps, percent: 0 });

    for (let i = 0; i < filesToUpload.length; i++) {
      await assertNotCancelled();
      const fp = filesToUpload[i], fn = path.basename(fp);
      try {
        await pw.write({ step: 'uploading', step_num: 2, total_steps: totalSteps, percent: Math.round((i / filesToUpload.length) * 100), current_file: fn });
        const { webViewLink } = await uploadToGoogleDrive(config, fp, fn);
        driveLinks.push({ name: fn, link: webViewLink }); resultLinks.push(webViewLink);
      } catch (err) {
        console.error(`${ts()} ❌ Drive: ${err.message}`);
        if (err.message.includes('storage quota') || err.message.includes('insufficient')) { driveLinks = []; break; }
      }
    }
    driveUploadOk = driveLinks.some(d => d.link && !d.link.startsWith('('));
    await pw.write({ step: 'uploading', step_num: 2, total_steps: totalSteps, percent: 100 });
  } else {
    await pw.write({ step: 'uploading', step_num: 2, total_steps: totalSteps, percent: 100, current_file: 'skipped' });
  }
  if (!driveUploadOk) for (const fp of filesToUpload) resultLinks.push(`file://${fp}`);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: EMAIL
  // ═══════════════════════════════════════════════════════════════════════
  await assertNotCancelled();
  if (request.email) {
    await pw.write({ step: 'emailing', step_num: totalSteps, total_steps: totalSteps, percent: 0, current_file: request.email });
    try {
      if (driveUploadOk) await sendResultEmail(config, request, filesToUpload, driveLinks);
      else await sendResultEmail(config, request, filesToUpload, null);
      await pw.write({ step: 'emailing', step_num: totalSteps, total_steps: totalSteps, percent: 100 });
      console.log(`${ts()} ✅ Email → ${request.email}`);
    } catch (err) { throw new Error(`Email failed: ${err.message}`); }
  } else {
    await pw.write({ step: 'emailing', step_num: totalSteps, total_steps: totalSteps, percent: 100, current_file: 'skipped' });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLEANUP: Xoá highlights ngay, giữ source 12h
  // ═══════════════════════════════════════════════════════════════════════
  if (!isFullDownload) {
    console.log(`${ts()} 🗑️ Xoá highlights (đã gửi xong)...`);
    try { await rm(outputDir, { recursive: true, force: true }); } catch (e) {}
  } else {
    console.log(`${ts()} 💾 Full download — giữ source, không xoá`);
  }

  // Source giữ lại — cleanup job sẽ xoá sau 12h

  await pw.flush();

  return {
    resultLinks,
    highlightCount: filesToUpload.length,
    totalSizeMB: parseFloat(totalSizeMB.toFixed(2)),
    isFullDownload,
    isLive: isLiveUrl,
    sourceInfo: {
      url: request.url,
      hash: urlHash,
      filePath: actualSource,
      fileSizeMB: parseInt(sourceSizeMB),
    },
  };
}

// Helper: read file as text
async function readFileText(p) {
  const { readFile } = await import('fs/promises');
  return readFile(p, 'utf-8');
}
