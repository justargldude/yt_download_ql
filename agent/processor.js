// processor.js — v4.0: Direct segment download (no full video download)
// Dùng yt-dlp --download-sections để tải trực tiếp đoạn cần cắt
import { spawn } from 'child_process';
import { mkdir, stat, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { ts } from './agent.js';
import { sendResultEmail } from './emailer.js';
import { uploadToGoogleDrive } from './uploader.js';

// ── TIME TAG HELPER ─────────────────────────────────────────────────────
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

// ── HUMAN-READABLE TIME ─────────────────────────────────────────────────
function humanTime(timestamp) {
  if (!timestamp) return '?';
  const parts = timestamp.split(':').map(Number);
  if (parts.length === 3) {
    const [h, m, s] = parts;
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
    return `${m}m${String(s).padStart(2, '0')}s`;
  }
  return timestamp;
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
      try {
        await db.ref(`requests/${requestId}/progress`).set(pending);
      } catch (e) { /* ignore Firebase write errors */ }
      pending = null;
    } else if (!flushTimer) {
      flushTimer = setTimeout(async () => {
        flushTimer = null;
        if (pending) {
          lastWrite = Date.now();
          try {
            await db.ref(`requests/${requestId}/progress`).set(pending);
          } catch (e) { /* ignore */ }
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

// ── PARSE PROGRESS FROM OUTPUT ──────────────────────────────────────────
function parseProgressLine(line) {
  // aria2c format: [#xxx 301MiB/1.5GiB(18%) CN:16 DL:6.4MiB ETA:3m22s]
  let m = line.match(/(\d+(?:\.\d+)?)([MKG]i?B)\/([.\d]+)([MKG]i?B)\((\d+)%\).*DL:([\d.]+)([MKG]i?B).*ETA:(\S+)/i);
  if (m) {
    return {
      downloaded: `${m[1]} ${m[2]}`,
      total_size: `${m[3]} ${m[4]}`,
      percent: parseFloat(m[5]),
      speed: `${m[6]} ${m[7]}/s`,
      eta: m[8].replace(/]/g, ''),
    };
  }
  // yt-dlp format: [download]  45.2% of ~1.85GiB at 15.4MiB/s ETA 00:50
  m = line.match(/(\d+\.?\d*)%\s+of\s+~?([\d.]+\s*\S+)\s+at\s+([\d.]+\s*\S+)\s+ETA\s+(\S+)/);
  if (m) {
    return {
      percent: parseFloat(m[1]),
      total_size: m[2],
      speed: m[3],
      eta: m[4],
    };
  }
  // yt-dlp simple: [download] 100% of  95.74MiB in 00:00:28
  m = line.match(/(\d+\.?\d*)%\s+of\s+~?([\d.]+\s*\S+)\s+in\s+(\S+)/);
  if (m) {
    return { percent: parseFloat(m[1]), total_size: m[2], downloaded: m[2], speed: null, eta: null };
  }
  return null;
}

// ── SPAWN ASYNC WITH PROGRESS CALLBACK ──────────────────────────────────
function spawnAsync(cmd, args, { prefix = '', cwd, onLine, onProc } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, windowsHide: true });
    let stderrBuf = '';

    if (onProc) onProc(proc);

    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          console.log(`${ts()} ${prefix} ${line}`);
          if (onLine) onLine(line);
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrBuf += text;
        const lines = text.split('\n').filter(Boolean);
        for (const line of lines) {
          console.log(`${ts()} ${prefix} ${line}`);
          if (onLine) onLine(line);
        }
      });
    }

    proc.on('error', (err) => reject(new Error(`Failed to spawn ${cmd}: ${err.message}`)));

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ code, stderr: stderrBuf });
      } else {
        reject(new Error(`${cmd} exited with code ${code}.\n${stderrBuf.slice(-500)}`));
      }
    });
  });
}

// ── KILL PROCESS TREE (Windows) ─────────────────────────────────────────
function killProcessTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    // Windows: kill entire process tree (yt-dlp + aria2c children)
    spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true });
  } catch (e) {
    try { proc.kill(); } catch (e2) { /* ignore */ }
  }
}

// ── FIND OUTPUT FILE (yt-dlp may modify filename) ───────────────────────
async function findOutputFile(outputDir, expectedBasename) {
  // Kiểm tra file đúng tên trước
  const expectedPath = path.join(outputDir, expectedBasename);
  if (existsSync(expectedPath)) return expectedPath;

  // yt-dlp có thể thêm title vào filename, tìm file .mp4 mới nhất
  try {
    const files = await readdir(outputDir);
    const mp4Files = files
      .filter(f => f.endsWith('.mp4') && !f.startsWith('source'))
      .map(f => ({ name: f, path: path.join(outputDir, f) }));

    if (mp4Files.length > 0) {
      // Trả về file mới nhất
      let newest = mp4Files[0];
      for (const f of mp4Files) {
        const s = await stat(f.path);
        const ns = await stat(newest.path);
        if (s.mtimeMs > ns.mtimeMs) newest = f;
      }
      return newest.path;
    }
  } catch (e) { /* ignore */ }

  return null;
}

// ── MAIN PROCESS REQUEST ────────────────────────────────────────────────
export async function processRequest(request, requestId, config, db, checkCancelled) {
  const outputDir = path.join(config.paths.outputDir, requestId);
  let currentProc = null;

  // Progress writer
  const pw = createProgressWriter(db, requestId);

  // Helper: cancel check + kill process
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
  if (segments.length === 0) {
    throw new Error('No segments specified in request.');
  }

  // ── COMMON YT-DLP ARGS ────────────────────────────────────────────────
  const ffmpegDir = path.dirname(config.paths.ffmpeg);
  const cookiesFile = config.paths.cookiesFile;

  // NOTE: Không dùng aria2c với --download-sections (xung đột với HLS/m3u8)
  // yt-dlp native + --concurrent-fragments đủ nhanh cho segment nhỏ
  function buildYtdlpArgs(segStart, segEnd, outputPath) {
    const args = [
      '--download-sections', `*${segStart}-${segEnd}`,
      '--concurrent-fragments', String(config.settings?.concurrentFragments || 16),
      '--retries', '10',
      '--fragment-retries', '10',
      '--force-overwrites',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      '-f', 'bv*+ba/b',
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', ffmpegDir,
      '-o', outputPath,
      '--no-playlist',
    ];

    if (cookiesFile && existsSync(cookiesFile)) {
      args.push('--cookies', cookiesFile);
    }

    args.push(request.url);
    return args;
  }

  // ── 2. TẢI TRỰC TIẾP TỪNG SEGMENT ────────────────────────────────────
  const highlightFiles = [];
  const totalSegments = segments.length;
  const datePart = (request.created_at || new Date().toISOString())
    .split('T')[0].replace(/-/g, '');

  console.log(`${ts()} ════════════════════════════════════════`);
  console.log(`${ts()} 📥 Direct segment download: ${totalSegments} segment(s)`);
  console.log(`${ts()} 🔗 ${request.url}`);
  console.log(`${ts()} ════════════════════════════════════════`);

  for (let i = 0; i < totalSegments; i++) {
    await assertNotCancelled();

    const seg = segments[i];
    const startTag = timeTag(seg.start);
    const endTag = timeTag(seg.end);
    const hlName = `HL_${datePart}_${startTag}-${endTag}.mp4`;
    const hlPath = path.join(outputDir, hlName);

    const segLabel = `${humanTime(seg.start)} → ${humanTime(seg.end)}`;

    console.log(`${ts()} ┌─────────────────────────────────────`);
    console.log(`${ts()} │ 📥 Segment ${i + 1}/${totalSegments}: ${segLabel}`);
    console.log(`${ts()} │ 📄 → ${hlName}`);
    console.log(`${ts()} └─────────────────────────────────────`);

    await pw.write({
      step: 'downloading', step_num: 1, total_steps: 3,
      percent: Math.round((i / totalSegments) * 100),
      speed: null, eta: null,
      current_file: hlName,
      segment_index: i + 1,
      segment_total: totalSegments,
      segment_range: segLabel,
    });

    const ytdlpArgs = buildYtdlpArgs(seg.start, seg.end, hlPath);
    const prefix = `[${i + 1}/${totalSegments}]`;

    // Progress callback
    const onLine = (line) => {
      const prog = parseProgressLine(line);
      if (prog) {
        pw.write({
          step: 'downloading', step_num: 1, total_steps: 3,
          percent: Math.round(((i + (prog.percent || 0) / 100) / totalSegments) * 100),
          speed: prog.speed, eta: prog.eta,
          downloaded: prog.downloaded || null,
          total_size: prog.total_size || null,
          current_file: hlName,
          segment_index: i + 1,
          segment_total: totalSegments,
          segment_range: segLabel,
        });
      }
    };

    // Periodic cancel check during download (every 3s)
    let downloadCancelled = false;
    const cancelChecker = setInterval(async () => {
      try {
        if (await checkCancelled()) {
          downloadCancelled = true;
          if (currentProc) killProcessTree(currentProc);
        }
      } catch (e) { /* ignore */ }
    }, 3000);

    try {
      await spawnAsync(config.paths.ytdlp, ytdlpArgs, {
        prefix, cwd: outputDir, onLine,
        onProc: (proc) => { currentProc = proc; }
      });
    } catch (err) {
      // Check if cancelled
      if (downloadCancelled || await checkCancelled()) {
        clearInterval(cancelChecker);
        throw new Error('CANCELLED');
      }

      throw err;
    } finally {
      clearInterval(cancelChecker);
    }
    currentProc = null;

    // Tìm file output (yt-dlp có thể đặt tên khác)
    const foundFile = await findOutputFile(outputDir, hlName);
    if (foundFile) {
      highlightFiles.push(foundFile);
      const fileStat = await stat(foundFile);
      const sizeMB = (fileStat.size / 1024 / 1024).toFixed(1);
      console.log(`${ts()} ✅ Segment ${i + 1} done: ${path.basename(foundFile)} (${sizeMB} MB)`);
    } else {
      console.warn(`${ts()} ⚠️ Segment ${i + 1} output not found! Expected: ${hlName}`);
    }
  }

  await pw.write({
    step: 'downloading', step_num: 1, total_steps: 3, percent: 100,
    speed: null, eta: null, current_file: null,
    segment_index: totalSegments, segment_total: totalSegments,
    segment_range: 'done',
  });

  console.log(`${ts()} ════════════════════════════════════════`);
  console.log(`${ts()} ✅ All segments downloaded: ${highlightFiles.length}/${totalSegments}`);
  console.log(`${ts()} ════════════════════════════════════════`);

  if (highlightFiles.length === 0) {
    throw new Error('No highlight files were produced. All segment downloads may have failed.');
  }

  // ── 3. TÍNH TỔNG SIZE + UPLOAD DRIVE ─────────────────────────────────
  await assertNotCancelled();

  let totalSize = 0;
  for (const fp of highlightFiles) {
    const info = await stat(fp);
    totalSize += info.size;
  }
  const totalSizeMB = totalSize / (1024 * 1024);
  const maxEmailMB = config.settings?.maxFileSizeForEmailMB || 25;

  console.log(`${ts()} 📊 Total: ${totalSizeMB.toFixed(1)} MB | Email limit: ${maxEmailMB} MB`);

  // Upload Google Drive (nếu có cấu hình)
  let driveLinks = [];
  const resultLinks = [];
  let driveUploadOk = false;

  if (config.google_drive?.serviceAccountPath && config.google_drive?.folderId) {
    console.log(`${ts()} ☁️  Uploading ${highlightFiles.length} file(s) to Google Drive...`);

    await pw.write({ step: 'uploading', step_num: 2, total_steps: 3, percent: 0,
      speed: null, eta: null, current_file: null });

    for (let i = 0; i < highlightFiles.length; i++) {
      await assertNotCancelled();
      const fp = highlightFiles[i];
      const fileName = path.basename(fp);
      try {
        await pw.write({ step: 'uploading', step_num: 2, total_steps: 3,
          percent: Math.round((i / highlightFiles.length) * 100),
          current_file: fileName });

        const { webViewLink } = await uploadToGoogleDrive(config, fp, fileName);
        driveLinks.push({ name: fileName, link: webViewLink });
        resultLinks.push(webViewLink);
        console.log(`${ts()} ✅ Uploaded: ${fileName}`);
      } catch (err) {
        console.error(`${ts()} ❌ Drive upload failed: ${err.message}`);
        if (err.message.includes('storage quota')) {
          console.log(`${ts()} ℹ️  Service Account không có quota Drive. Sẽ đính kèm email.`);
          driveLinks = [];
          break; // Bỏ qua Drive, dùng email attachment
        }
        driveLinks.push({ name: fileName, link: `(upload failed)` });
      }
    }

    driveUploadOk = driveLinks.some(d => d.link && !d.link.startsWith('(upload'));
    await pw.write({ step: 'uploading', step_num: 2, total_steps: 3, percent: 100 });
  } else {
    console.log(`${ts()} ℹ️  Google Drive not configured — email attachment only`);
    await pw.write({ step: 'uploading', step_num: 2, total_steps: 3, percent: 100,
      current_file: 'skipped' });
  }

  // Nếu Drive fail → dùng file:// links
  if (!driveUploadOk) {
    for (const fp of highlightFiles) {
      if (!resultLinks.includes(`file://${fp}`)) resultLinks.push(`file://${fp}`);
    }
  }

  // ── 4. GỬI EMAIL ─────────────────────────────────────────────────────
  await assertNotCancelled();

  if (request.email) {
    await pw.write({ step: 'emailing', step_num: 3, total_steps: 3, percent: 0,
      current_file: request.email });
    try {
      if (driveUploadOk) {
        // Drive thành công → gửi link Drive (không đính kèm)
        console.log(`${ts()} 📧 Sending Drive links to ${request.email}`);
        await sendResultEmail(config, request, highlightFiles, driveLinks);
      } else {
        // Drive thất bại hoặc không cấu hình → đính kèm file (tự batch nếu quá lớn)
        console.log(`${ts()} 📧 Attaching files to email (auto-batch if > ${maxEmailMB} MB)`);
        await sendResultEmail(config, request, highlightFiles, null);
      }
      await pw.write({ step: 'emailing', step_num: 3, total_steps: 3, percent: 100 });
      console.log(`${ts()} ✅ Email sent to ${request.email}`);
    } catch (err) {
      console.error(`${ts()} ❌ Email failed: ${err.message}`);
      throw new Error(`Email failed: ${err.message}`);
    }
  } else {
    console.log(`${ts()} ⚠️ No email — skipping`);
    await pw.write({ step: 'emailing', step_num: 3, total_steps: 3, percent: 100,
      current_file: 'skipped' });
  }

  await pw.flush();

  // ── 5. KẾT QUẢ ───────────────────────────────────────────────────────
  return {
    resultLinks,
    highlightCount: highlightFiles.length,
    totalSizeMB: parseFloat(totalSizeMB.toFixed(2)),
    sourceInfo: null, // Không có source file — tải trực tiếp segment
  };
}
