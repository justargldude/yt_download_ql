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
    const proc = spawn(cmd, args, { cwd, windowsHide: true });
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
  try { spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true }); }
  catch (e) { try { proc.kill(); } catch (e2) {} }
}

// ═════════════════════════════════════════════════════════════════════════
export async function processRequest(request, requestId, config, db, checkCancelled) {
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
  if (segments.length === 0) throw new Error('No segments specified.');

  const ffmpegDir = path.dirname(config.paths.ffmpeg);
  const ytdlpDir = path.dirname(config.paths.ytdlp);
  const aria2cPath = path.join(ytdlpDir, 'aria2c.exe');
  const useAria2c = existsSync(aria2cPath);
  const cookiesFile = config.paths.cookiesFile;
  const totalSegments = segments.length;
  const datePart = (request.created_at || new Date().toISOString()).split('T')[0].replace(/-/g, '');

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
      step: 'downloading', step_num: 1, total_steps: 3, percent: 100,
      current_file: 'Dùng source cache', segment_range: `♻️ Đã tải trước — skip download!`,
    });
    sourceReused = true;
  } else {
    // ── DOWNLOAD MỚI ──
    console.log(`${ts()} ════════════════════════════════════════`);
    console.log(`${ts()} 📥 Downloading video → ${sourceDir}`);
    console.log(`${ts()} 🔗 ${request.url}`);
    if (useAria2c) console.log(`${ts()} 🚀 aria2c accelerator active`);
    console.log(`${ts()} ════════════════════════════════════════`);

    const dlArgs = [
      '--concurrent-fragments', String(config.settings?.concurrentFragments || 16),
      '--retries', '10', '--fragment-retries', '10',
      '--user-agent', UA,
      '-f', 'bv*+ba/b', '--merge-output-format', 'mp4',
      '--ffmpeg-location', ffmpegDir,
      '-o', sourcePath, '--no-playlist',
    ];
    if (cookiesFile && existsSync(cookiesFile)) dlArgs.push('--cookies', cookiesFile);
    if (/\/live\//i.test(request.url)) dlArgs.push('--live-from-start');
    if (useAria2c) {
      dlArgs.push('--downloader', 'aria2c');
      dlArgs.push('--downloader-args', 'aria2c:-x 16 -s 16 -j 16 -k 1M --allow-overwrite=true --auto-file-renaming=false');
    }
    dlArgs.push(request.url);

    const onDlLine = (line) => {
      const prog = parseProgressLine(line);
      if (prog) {
        pw.write({
          step: 'downloading', step_num: 1, total_steps: 3,
          percent: Math.round(prog.percent || 0),
          speed: prog.speed, eta: prog.eta,
          downloaded: prog.downloaded || null, total_size: prog.total_size || null,
          current_file: 'source.mp4',
          segment_range: `Tải video → cắt ${totalSegments} đoạn`,
        });
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
      if (dlCancelled || await checkCancelled()) { clearInterval(cancelCheck); throw new Error('CANCELLED'); }
      // Retry without aria2c
      if (useAria2c) {
        console.log(`${ts()} ⚠️ aria2c failed, retrying native...`);
        const clean = dlArgs.filter(a => a !== '--downloader' && a !== 'aria2c' && !a.startsWith('aria2c:'));
        const retry = []; for (let j = 0; j < clean.length; j++) { if (clean[j] === '--downloader-args') { j++; continue; } retry.push(clean[j]); }
        await assertNotCancelled();
        try { await spawnAsync(config.paths.ytdlp, retry, { prefix: '[retry]', cwd: sourceDir, onLine: onDlLine, onProc: (p) => { currentProc = p; } }); }
        catch (e2) { if (dlCancelled || await checkCancelled()) { clearInterval(cancelCheck); throw new Error('CANCELLED'); } throw e2; }
      } else throw err;
    } finally { clearInterval(cancelCheck); }
    currentProc = null;
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

  await pw.write({ step: 'downloading', step_num: 1, total_steps: 3, percent: 100, segment_range: 'Đang cắt...' });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1b: CUT SEGMENTS
  // ═══════════════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: UPLOAD
  // ═══════════════════════════════════════════════════════════════════════
  await assertNotCancelled();
  let totalSize = 0;
  for (const fp of highlightFiles) totalSize += (await stat(fp)).size;
  const totalSizeMB = totalSize / (1024 * 1024);
  const maxEmailMB = config.settings?.maxFileSizeForEmailMB || 25;
  console.log(`${ts()} 📊 Total: ${totalSizeMB.toFixed(1)} MB`);

  let driveLinks = [], resultLinks = [], driveUploadOk = false;

  if (config.google_drive?.folderId && (config.google_drive?.clientId || config.google_drive?.serviceAccountPath)) {
    console.log(`${ts()} ☁️  Uploading ${highlightFiles.length} file(s) to Drive...`);
    await pw.write({ step: 'uploading', step_num: 2, total_steps: 3, percent: 0 });

    for (let i = 0; i < highlightFiles.length; i++) {
      await assertNotCancelled();
      const fp = highlightFiles[i], fn = path.basename(fp);
      try {
        await pw.write({ step: 'uploading', step_num: 2, total_steps: 3, percent: Math.round((i / highlightFiles.length) * 100), current_file: fn });
        const { webViewLink } = await uploadToGoogleDrive(config, fp, fn);
        driveLinks.push({ name: fn, link: webViewLink }); resultLinks.push(webViewLink);
      } catch (err) {
        console.error(`${ts()} ❌ Drive: ${err.message}`);
        if (err.message.includes('storage quota') || err.message.includes('insufficient')) { driveLinks = []; break; }
      }
    }
    driveUploadOk = driveLinks.some(d => d.link && !d.link.startsWith('('));
    await pw.write({ step: 'uploading', step_num: 2, total_steps: 3, percent: 100 });
  } else {
    await pw.write({ step: 'uploading', step_num: 2, total_steps: 3, percent: 100, current_file: 'skipped' });
  }
  if (!driveUploadOk) for (const fp of highlightFiles) resultLinks.push(`file://${fp}`);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: EMAIL
  // ═══════════════════════════════════════════════════════════════════════
  await assertNotCancelled();
  if (request.email) {
    await pw.write({ step: 'emailing', step_num: 3, total_steps: 3, percent: 0, current_file: request.email });
    try {
      if (driveUploadOk) await sendResultEmail(config, request, highlightFiles, driveLinks);
      else await sendResultEmail(config, request, highlightFiles, null);
      await pw.write({ step: 'emailing', step_num: 3, total_steps: 3, percent: 100 });
      console.log(`${ts()} ✅ Email → ${request.email}`);
    } catch (err) { throw new Error(`Email failed: ${err.message}`); }
  } else {
    await pw.write({ step: 'emailing', step_num: 3, total_steps: 3, percent: 100, current_file: 'skipped' });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLEANUP: Xoá highlights ngay, giữ source 12h
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`${ts()} 🗑️ Xoá highlights (đã gửi xong)...`);
  try { await rm(outputDir, { recursive: true, force: true }); } catch (e) {}

  // Source giữ lại — cleanup job sẽ xoá sau 12h

  await pw.flush();

  return {
    resultLinks,
    highlightCount: highlightFiles.length,
    totalSizeMB: parseFloat(totalSizeMB.toFixed(2)),
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
