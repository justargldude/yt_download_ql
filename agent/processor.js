// processor.js — v4.1: yt-dlp -g + ffmpeg direct segment extraction
// Cách hoạt động:
//   1. yt-dlp -g → lấy URL trực tiếp của video + audio (1 lần)
//   2. ffmpeg -ss START -t DURATION -i URL → cắt trực tiếp từ stream (mỗi segment)
// Tránh --download-sections bị treo trên live stream dài
import { spawn } from 'child_process';
import { mkdir, stat } from 'fs/promises';
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

function toSeconds(ts) {
  const parts = ts.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

// ── PROGRESS WRITER ─────────────────────────────────────────────────────
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
      try { await db.ref(`requests/${requestId}/progress`).set(pending); } catch (e) { /* ignore */ }
      pending = null;
    } else if (!flushTimer) {
      flushTimer = setTimeout(async () => {
        flushTimer = null;
        if (pending) {
          lastWrite = Date.now();
          try { await db.ref(`requests/${requestId}/progress`).set(pending); } catch (e) { /* ignore */ }
          pending = null;
        }
      }, 2000 - (now - lastWrite));
    }
  }

  async function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pending) {
      try { await db.ref(`requests/${requestId}/progress`).set(pending); } catch (e) { /* ignore */ }
      pending = null;
    }
  }

  return { write, flush };
}

// ── SPAWN: stream output to console ─────────────────────────────────────
function spawnAsync(cmd, args, { prefix = '', cwd, onLine, onProc } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, windowsHide: true });
    let stderrBuf = '';
    if (onProc) onProc(proc);

    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          console.log(`${ts()} ${prefix} ${line}`);
          if (onLine) onLine(line);
        }
      });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrBuf += text;
        for (const line of text.split('\n').filter(Boolean)) {
          console.log(`${ts()} ${prefix} ${line}`);
          if (onLine) onLine(line);
        }
      });
    }

    proc.on('error', (err) => reject(new Error(`Failed to spawn ${cmd}: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve({ code, stderr: stderrBuf });
      else reject(new Error(`${cmd} exited with code ${code}.\n${stderrBuf.slice(-500)}`));
    });
  });
}

// ── SPAWN: capture stdout (for yt-dlp -g) ───────────────────────────────
function spawnCapture(cmd, args, { cwd, onProc } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, windowsHide: true });
    if (onProc) onProc(proc);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => {
      const text = d.toString();
      stderr += text;
      for (const line of text.split('\n').filter(Boolean)) {
        console.log(`${ts()} [extract] ${line}`);
      }
    });

    proc.on('error', err => reject(new Error(`Failed to spawn ${cmd}: ${err.message}`)));
    proc.on('close', code => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr });
      else reject(new Error(`${cmd} exited with code ${code}.\n${stderr.slice(-500)}`));
    });
  });
}

// ── KILL PROCESS TREE (Windows) ─────────────────────────────────────────
function killProcessTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true });
  } catch (e) {
    try { proc.kill(); } catch (e2) { /* ignore */ }
  }
}

// ── MAIN PROCESS REQUEST ────────────────────────────────────────────────
export async function processRequest(request, requestId, config, db, checkCancelled) {
  const outputDir = path.join(config.paths.outputDir, requestId);
  let currentProc = null;
  const pw = createProgressWriter(db, requestId);

  async function assertNotCancelled() {
    if (await checkCancelled()) {
      if (currentProc) killProcessTree(currentProc);
      throw new Error('CANCELLED');
    }
  }

  // 1. Tạo thư mục output
  await mkdir(outputDir, { recursive: true });
  console.log(`${ts()} 📁 Output: ${outputDir}`);

  const segments = request.segments || [];
  if (segments.length === 0) throw new Error('No segments specified.');

  const cookiesFile = config.paths.cookiesFile;
  const totalSegments = segments.length;
  const datePart = (request.created_at || new Date().toISOString()).split('T')[0].replace(/-/g, '');

  // ── STEP 1: EXTRACT DIRECT STREAM URLs ────────────────────────────────
  console.log(`${ts()} ════════════════════════════════════════`);
  console.log(`${ts()} 🔍 Extracting stream URLs from YouTube...`);
  console.log(`${ts()} 🔗 ${request.url}`);
  console.log(`${ts()} ════════════════════════════════════════`);

  await pw.write({
    step: 'downloading', step_num: 1, total_steps: 3,
    percent: 0, speed: null, eta: 'extracting URLs...',
    current_file: 'Đang lấy link stream...', segment_index: 0, segment_total: totalSegments,
    segment_range: 'preparing',
  });

  // yt-dlp -g: trả về URL trực tiếp (video + audio riêng)
  const extractArgs = [
    '-g',
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b',
    '--no-playlist',
    '--user-agent', UA,
  ];
  if (cookiesFile && existsSync(cookiesFile)) {
    extractArgs.push('--cookies', cookiesFile);
  }
  extractArgs.push(request.url);

  await assertNotCancelled();

  let videoUrl, audioUrl;
  try {
    const { stdout } = await spawnCapture(config.paths.ytdlp, extractArgs, {
      onProc: (proc) => { currentProc = proc; }
    });
    currentProc = null;

    const urls = stdout.split('\n').filter(Boolean);
    if (urls.length === 0) throw new Error('yt-dlp -g returned no URLs');

    videoUrl = urls[0];
    audioUrl = urls.length > 1 ? urls[1] : null;

    console.log(`${ts()} ✅ Got stream URLs:`);
    console.log(`${ts()}   📹 Video: ${videoUrl.substring(0, 80)}...`);
    if (audioUrl) console.log(`${ts()}   🔊 Audio: ${audioUrl.substring(0, 80)}...`);
    else console.log(`${ts()}   🔊 Audio: embedded in video`);
  } catch (err) {
    if (await checkCancelled()) throw new Error('CANCELLED');
    throw new Error(`Failed to extract URLs: ${err.message}`);
  }

  // ── STEP 2: CUT EACH SEGMENT WITH FFMPEG ─────────────────────────────
  const highlightFiles = [];

  for (let i = 0; i < totalSegments; i++) {
    await assertNotCancelled();

    const seg = segments[i];
    const startTag = timeTag(seg.start);
    const endTag = timeTag(seg.end);
    const hlName = `HL_${datePart}_${startTag}-${endTag}.mp4`;
    const hlPath = path.join(outputDir, hlName);
    const duration = toSeconds(seg.end) - toSeconds(seg.start);
    const segLabel = `${timeTag(seg.start)} → ${timeTag(seg.end)}`;

    console.log(`${ts()} ┌─────────────────────────────────────`);
    console.log(`${ts()} │ ✂️  Segment ${i + 1}/${totalSegments}: ${segLabel} (${duration}s)`);
    console.log(`${ts()} │ 📄 → ${hlName}`);
    console.log(`${ts()} └─────────────────────────────────────`);

    await pw.write({
      step: 'downloading', step_num: 1, total_steps: 3,
      percent: Math.round((i / totalSegments) * 100),
      speed: null, eta: null,
      current_file: hlName,
      segment_index: i + 1, segment_total: totalSegments,
      segment_range: segLabel,
    });

    // Build ffmpeg args: seek + download only needed part
    const ffmpegArgs = ['-y', '-loglevel', 'warning', '-stats'];

    // Video input with seek
    ffmpegArgs.push('-user_agent', UA);
    ffmpegArgs.push('-referer', 'https://www.youtube.com/');
    ffmpegArgs.push('-ss', seg.start);
    ffmpegArgs.push('-i', videoUrl);

    // Audio input with seek (if separate)
    if (audioUrl) {
      ffmpegArgs.push('-user_agent', UA);
      ffmpegArgs.push('-referer', 'https://www.youtube.com/');
      ffmpegArgs.push('-ss', seg.start);
      ffmpegArgs.push('-i', audioUrl);
      ffmpegArgs.push('-map', '0:v:0', '-map', '1:a:0');
    }

    ffmpegArgs.push('-t', String(duration));
    ffmpegArgs.push('-c', 'copy');
    ffmpegArgs.push('-avoid_negative_ts', 'make_zero');
    ffmpegArgs.push('-movflags', '+faststart');
    ffmpegArgs.push(hlPath);

    // Periodic cancel check (every 3s)
    let cancelled = false;
    const cancelChecker = setInterval(async () => {
      try {
        if (await checkCancelled()) {
          cancelled = true;
          if (currentProc) killProcessTree(currentProc);
        }
      } catch (e) { /* ignore */ }
    }, 3000);

    try {
      await spawnAsync(config.paths.ffmpeg, ffmpegArgs, {
        prefix: `[ffmpeg ${i + 1}/${totalSegments}]`,
        cwd: outputDir,
        onProc: (proc) => { currentProc = proc; }
      });
    } catch (err) {
      if (cancelled || await checkCancelled()) {
        clearInterval(cancelChecker);
        throw new Error('CANCELLED');
      }
      throw err;
    } finally {
      clearInterval(cancelChecker);
    }
    currentProc = null;

    // Verify output
    if (existsSync(hlPath)) {
      highlightFiles.push(hlPath);
      const fileStat = await stat(hlPath);
      const sizeMB = (fileStat.size / 1024 / 1024).toFixed(1);
      console.log(`${ts()} ✅ Segment ${i + 1} done: ${hlName} (${sizeMB} MB)`);
    } else {
      console.warn(`${ts()} ⚠️ Segment ${i + 1} output not found: ${hlName}`);
    }
  }

  await pw.write({
    step: 'downloading', step_num: 1, total_steps: 3, percent: 100,
    speed: null, eta: null, current_file: null,
    segment_index: totalSegments, segment_total: totalSegments,
    segment_range: 'done',
  });

  console.log(`${ts()} ════════════════════════════════════════`);
  console.log(`${ts()} ✅ All segments: ${highlightFiles.length}/${totalSegments}`);
  console.log(`${ts()} ════════════════════════════════════════`);

  if (highlightFiles.length === 0) {
    throw new Error('No highlight files produced.');
  }

  // ── STEP 3: UPLOAD + EMAIL ────────────────────────────────────────────
  await assertNotCancelled();

  let totalSize = 0;
  for (const fp of highlightFiles) {
    const info = await stat(fp);
    totalSize += info.size;
  }
  const totalSizeMB = totalSize / (1024 * 1024);
  const maxEmailMB = config.settings?.maxFileSizeForEmailMB || 25;

  console.log(`${ts()} 📊 Total: ${totalSizeMB.toFixed(1)} MB | Email limit: ${maxEmailMB} MB`);

  // Upload Google Drive (nếu có)
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
          console.log(`${ts()} ℹ️  Bỏ qua Drive → đính kèm email`);
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

  // Email
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
