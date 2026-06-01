// processor.js — v4.2: Full download + ffmpeg cut (proven reliable)
// YouTube live VODs không hỗ trợ HTTP seek → phải tải toàn bộ rồi cắt
// Flow: yt-dlp (full download) → ffmpeg -ss -to -c copy (instant cut) → upload/email
import { spawn } from 'child_process';
import { mkdir, stat, unlink, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { ts } from './agent.js';
import { sendResultEmail } from './emailer.js';
import { uploadToGoogleDrive } from './uploader.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ── HELPERS ─────────────────────────────────────────────────────────────
function timeTag(timestamp) {
  if (!timestamp) return 'unknown';
  const parts = timestamp.split(':').map(Number);
  if (parts.length === 3) {
    const [h, m, s] = parts;
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
    return `${m}m${String(s).padStart(2, '0')}s`;
  }
  if (parts.length === 2) {
    const [m, s] = parts;
    return `${m}m${String(s).padStart(2, '0')}s`;
  }
  return timestamp.replace(/:/g, '-');
}

// ── PROGRESS WRITER (throttled to 1 write per 2s) ──────────────────────
function createProgressWriter(db, requestId) {
  let lastWrite = 0;
  let pending = null;
  let flushTimer = null;

  async function write(progressObj) {
    const now = Date.now();
    progressObj.updated_at = new Date().toISOString();
    pending = progressObj;
    if (now - lastWrite >= 2000) {
      lastWrite = now;
      try { await db.ref(`requests/${requestId}/progress`).set(pending); } catch (e) { /* */ }
      pending = null;
    } else if (!flushTimer) {
      flushTimer = setTimeout(async () => {
        flushTimer = null;
        if (pending) {
          lastWrite = Date.now();
          try { await db.ref(`requests/${requestId}/progress`).set(pending); } catch (e) { /* */ }
          pending = null;
        }
      }, 2000 - (now - lastWrite));
    }
  }

  async function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pending) {
      try { await db.ref(`requests/${requestId}/progress`).set(pending); } catch (e) { /* */ }
      pending = null;
    }
  }

  return { write, flush };
}

// ── PARSE PROGRESS ──────────────────────────────────────────────────────
function parseProgressLine(line) {
  // aria2c: [#xxx 301MiB/1.5GiB(18%) CN:16 DL:6.4MiB ETA:3m22s]
  let m = line.match(/(\d+(?:\.\d+)?)([MKG]i?B)\/([.\d]+)([MKG]i?B)\((\d+)%\).*DL:([\d.]+)([MKG]i?B).*ETA:(\S+)/i);
  if (m) {
    return {
      downloaded: `${m[1]} ${m[2]}`, total_size: `${m[3]} ${m[4]}`,
      percent: parseFloat(m[5]), speed: `${m[6]} ${m[7]}/s`, eta: m[8].replace(/]/g, ''),
    };
  }
  // yt-dlp: [download]  45.2% of ~1.85GiB at 15.4MiB/s ETA 00:50
  m = line.match(/(\d+\.?\d*)%\s+of\s+~?([\d.]+\s*\S+)\s+at\s+([\d.]+\s*\S+)\s+ETA\s+(\S+)/);
  if (m) {
    return { percent: parseFloat(m[1]), total_size: m[2], speed: m[3], eta: m[4] };
  }
  // yt-dlp complete: [download] 100% of  95.74MiB in 00:00:28
  m = line.match(/(\d+\.?\d*)%\s+of\s+~?([\d.]+\s*\S+)\s+in\s+(\S+)/);
  if (m) {
    return { percent: parseFloat(m[1]), total_size: m[2], downloaded: m[2], speed: null, eta: null };
  }
  return null;
}

// ── SPAWN ───────────────────────────────────────────────────────────────
function spawnAsync(cmd, args, { prefix = '', cwd, onLine, onProc } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, windowsHide: true });
    let stderrBuf = '';
    if (onProc) onProc(proc);

    const handleData = (chunk) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        console.log(`${ts()} ${prefix} ${line}`);
        if (onLine) onLine(line);
      }
    };

    if (proc.stdout) proc.stdout.on('data', handleData);
    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        handleData(chunk);
      });
    }

    proc.on('error', (err) => reject(new Error(`Failed to spawn ${cmd}: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve({ code, stderr: stderrBuf });
      else reject(new Error(`${cmd} exited with code ${code}.\n${stderrBuf.slice(-500)}`));
    });
  });
}

// ── KILL PROCESS TREE ───────────────────────────────────────────────────
function killProcessTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true });
  } catch (e) {
    try { proc.kill(); } catch (e2) { /* */ }
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════
export async function processRequest(request, requestId, config, db, checkCancelled) {
  const outputDir = path.join(config.paths.outputDir, requestId);
  const sourcePath = path.join(outputDir, 'source.mp4');
  let currentProc = null;
  const pw = createProgressWriter(db, requestId);

  async function assertNotCancelled() {
    if (await checkCancelled()) {
      if (currentProc) killProcessTree(currentProc);
      throw new Error('CANCELLED');
    }
  }

  await mkdir(outputDir, { recursive: true });
  console.log(`${ts()} 📁 Output: ${outputDir}`);

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
  // STEP 1: DOWNLOAD FULL VIDEO
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`${ts()} ════════════════════════════════════════`);
  console.log(`${ts()} 📥 Downloading full video...`);
  console.log(`${ts()} 🔗 ${request.url}`);
  if (useAria2c) console.log(`${ts()} 🚀 aria2c accelerator active`);
  console.log(`${ts()} ════════════════════════════════════════`);

  const dlArgs = [
    '--concurrent-fragments', String(config.settings?.concurrentFragments || 16),
    '--retries', '10',
    '--fragment-retries', '10',
    '--user-agent', UA,
    '-f', 'bv*+ba/b',
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', ffmpegDir,
    '-o', sourcePath,
    '--no-playlist',
  ];

  if (cookiesFile && existsSync(cookiesFile)) {
    dlArgs.push('--cookies', cookiesFile);
  }

  // Detect live stream → add --live-from-start
  if (/\/live\//i.test(request.url)) {
    dlArgs.push('--live-from-start');
  }

  if (useAria2c) {
    dlArgs.push('--downloader', 'aria2c');
    dlArgs.push('--downloader-args', 'aria2c:-x 16 -s 16 -j 16 -k 1M --allow-overwrite=true --auto-file-renaming=false');
  }

  dlArgs.push(request.url);

  // Progress callback for download
  const onDownloadLine = (line) => {
    const prog = parseProgressLine(line);
    if (prog) {
      pw.write({
        step: 'downloading', step_num: 1, total_steps: 3,
        percent: Math.round(prog.percent || 0),
        speed: prog.speed, eta: prog.eta,
        downloaded: prog.downloaded || null,
        total_size: prog.total_size || null,
        current_file: 'source.mp4',
        segment_index: null, segment_total: totalSegments,
        segment_range: `Tải toàn bộ video → cắt ${totalSegments} đoạn`,
      });
    }
  };

  // Cancel checker
  let downloadCancelled = false;
  const cancelChecker = setInterval(async () => {
    try {
      if (await checkCancelled()) {
        downloadCancelled = true;
        if (currentProc) killProcessTree(currentProc);
      }
    } catch (e) { /* */ }
  }, 3000);

  try {
    await spawnAsync(config.paths.ytdlp, dlArgs, {
      prefix: '[yt-dlp]', cwd: outputDir, onLine: onDownloadLine,
      onProc: (proc) => { currentProc = proc; }
    });
  } catch (err) {
    if (downloadCancelled || await checkCancelled()) {
      clearInterval(cancelChecker);
      throw new Error('CANCELLED');
    }

    // Retry without aria2c if it failed
    if (useAria2c && !downloadCancelled) {
      console.log(`${ts()} ⚠️ aria2c failed, retrying with native downloader...`);
      const retryArgs = dlArgs.filter(a =>
        a !== '--downloader' && a !== 'aria2c' && !a.startsWith('aria2c:')
      );
      const cleanArgs = [];
      for (let j = 0; j < retryArgs.length; j++) {
        if (retryArgs[j] === '--downloader-args') { j++; continue; }
        cleanArgs.push(retryArgs[j]);
      }

      await assertNotCancelled();
      try {
        await spawnAsync(config.paths.ytdlp, cleanArgs, {
          prefix: '[yt-dlp retry]', cwd: outputDir, onLine: onDownloadLine,
          onProc: (proc) => { currentProc = proc; }
        });
      } catch (retryErr) {
        if (downloadCancelled || await checkCancelled()) {
          clearInterval(cancelChecker);
          throw new Error('CANCELLED');
        }
        throw retryErr;
      }
    } else {
      throw err;
    }
  } finally {
    clearInterval(cancelChecker);
  }
  currentProc = null;

  // Find the source file (yt-dlp may modify filename)
  let actualSource = sourcePath;
  if (!existsSync(sourcePath)) {
    const files = await readdir(outputDir);
    const mp4 = files.find(f => f.endsWith('.mp4'));
    if (mp4) actualSource = path.join(outputDir, mp4);
    else throw new Error('Source file not found after download.');
  }

  const sourceInfo = await stat(actualSource);
  const sourceSizeMB = (sourceInfo.size / 1024 / 1024).toFixed(0);
  console.log(`${ts()} ✅ Download complete: ${sourceSizeMB} MB`);

  await pw.write({
    step: 'downloading', step_num: 1, total_steps: 3, percent: 100,
    current_file: 'source.mp4', segment_range: 'Tải xong! Đang cắt...',
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1b: CUT SEGMENTS WITH FFMPEG (instant, -c copy)
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`${ts()} ✂️  Cutting ${totalSegments} segment(s)...`);

  const highlightFiles = [];

  for (let i = 0; i < totalSegments; i++) {
    await assertNotCancelled();

    const seg = segments[i];
    const startTag = timeTag(seg.start);
    const endTag = timeTag(seg.end);
    const hlName = `HL_${datePart}_${startTag}-${endTag}.mp4`;
    const hlPath = path.join(outputDir, hlName);

    console.log(`${ts()} ✂️  [${i + 1}/${totalSegments}] ${seg.start} → ${seg.end} → ${hlName}`);

    const ffmpegArgs = [
      '-y', '-loglevel', 'error',
      '-ss', seg.start, '-to', seg.end,
      '-i', actualSource,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      hlPath,
    ];

    try {
      await spawnAsync(config.paths.ffmpeg, ffmpegArgs, {
        prefix: `[ffmpeg ${i + 1}/${totalSegments}]`, cwd: outputDir,
        onProc: (proc) => { currentProc = proc; }
      });
    } catch (err) {
      console.error(`${ts()} ❌ Cut failed for segment ${i + 1}: ${err.message}`);
      continue; // Skip failed segment, try next
    }
    currentProc = null;

    if (existsSync(hlPath)) {
      highlightFiles.push(hlPath);
    }
  }

  console.log(`${ts()} ✅ Cut complete: ${highlightFiles.length}/${totalSegments} highlights`);

  // Delete source file immediately to save disk space
  try {
    await unlink(actualSource);
    console.log(`${ts()} 🗑️ Source deleted (${sourceSizeMB} MB freed)`);
  } catch (e) { /* ignore */ }

  // Also delete any leftover temp files (f399, f251, etc.)
  try {
    const leftover = await readdir(outputDir);
    for (const f of leftover) {
      if (f.startsWith('source.f') || f.endsWith('.webm') || f.endsWith('.part')) {
        try { await unlink(path.join(outputDir, f)); } catch (e) { /* */ }
      }
    }
  } catch (e) { /* */ }

  if (highlightFiles.length === 0) {
    throw new Error('No highlights produced.');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: UPLOAD TO GOOGLE DRIVE
  // ═══════════════════════════════════════════════════════════════════════
  await assertNotCancelled();

  let totalSize = 0;
  for (const fp of highlightFiles) {
    totalSize += (await stat(fp)).size;
  }
  const totalSizeMB = totalSize / (1024 * 1024);
  const maxEmailMB = config.settings?.maxFileSizeForEmailMB || 25;

  console.log(`${ts()} 📊 Total: ${totalSizeMB.toFixed(1)} MB | Email limit: ${maxEmailMB} MB`);

  let driveLinks = [];
  const resultLinks = [];
  let driveUploadOk = false;

  if (config.google_drive?.serviceAccountPath && config.google_drive?.folderId) {
    console.log(`${ts()} ☁️  Uploading ${highlightFiles.length} file(s) to Drive...`);
    await pw.write({ step: 'uploading', step_num: 2, total_steps: 3, percent: 0, current_file: null });

    for (let i = 0; i < highlightFiles.length; i++) {
      await assertNotCancelled();
      const fp = highlightFiles[i];
      const fileName = path.basename(fp);
      try {
        await pw.write({ step: 'uploading', step_num: 2, total_steps: 3,
          percent: Math.round((i / highlightFiles.length) * 100), current_file: fileName });
        const { webViewLink } = await uploadToGoogleDrive(config, fp, fileName);
        driveLinks.push({ name: fileName, link: webViewLink });
        resultLinks.push(webViewLink);
      } catch (err) {
        console.error(`${ts()} ❌ Drive: ${err.message}`);
        if (err.message.includes('storage quota')) {
          console.log(`${ts()} ℹ️  Bỏ qua Drive → email`);
          driveLinks = [];
          break;
        }
      }
    }

    driveUploadOk = driveLinks.some(d => d.link && !d.link.startsWith('('));
    await pw.write({ step: 'uploading', step_num: 2, total_steps: 3, percent: 100 });
  } else {
    await pw.write({ step: 'uploading', step_num: 2, total_steps: 3, percent: 100, current_file: 'skipped' });
  }

  if (!driveUploadOk) {
    for (const fp of highlightFiles) resultLinks.push(`file://${fp}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: SEND EMAIL
  // ═══════════════════════════════════════════════════════════════════════
  await assertNotCancelled();

  if (request.email) {
    await pw.write({ step: 'emailing', step_num: 3, total_steps: 3, percent: 0, current_file: request.email });
    try {
      if (driveUploadOk) {
        await sendResultEmail(config, request, highlightFiles, driveLinks);
      } else {
        console.log(`${ts()} 📧 Đính kèm file (tự batch nếu > ${maxEmailMB} MB)`);
        await sendResultEmail(config, request, highlightFiles, null);
      }
      await pw.write({ step: 'emailing', step_num: 3, total_steps: 3, percent: 100 });
      console.log(`${ts()} ✅ Email sent to ${request.email}`);
    } catch (err) {
      throw new Error(`Email failed: ${err.message}`);
    }
  } else {
    await pw.write({ step: 'emailing', step_num: 3, total_steps: 3, percent: 100, current_file: 'skipped' });
  }

  await pw.flush();

  return {
    resultLinks,
    highlightCount: highlightFiles.length,
    totalSizeMB: parseFloat(totalSizeMB.toFixed(2)),
    sourceInfo: null,
  };
}
