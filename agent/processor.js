// processor.js — v3.0: Tải video, cắt highlight, upload/gửi email
// + Fix aria2c error 13, progress streaming, cancel support, source reuse
import { spawn } from 'child_process';
import { mkdir, stat, unlink, readdir } from 'fs/promises';
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
  let m = line.match(/(\d+(?:\.\d+)?)([MKG]i?B)\/([\d.]+)([MKG]i?B)\((\d+)%\).*DL:([\d.]+)([MKG]i?B).*ETA:(\S+)/i);
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

// ── MAIN PROCESS REQUEST ────────────────────────────────────────────────
export async function processRequest(request, requestId, config, db, checkCancelled) {
  const outputDir = path.join(config.paths.outputDir, requestId);
  const sourceFile = path.join(outputDir, 'source.mp4');
  let currentProc = null; // Reference to running child process for cancel

  // Progress writer
  const pw = createProgressWriter(db, requestId);

  // Helper: cancel check + kill process
  async function assertNotCancelled() {
    if (await checkCancelled()) {
      if (currentProc) {
        try { currentProc.kill(); } catch (e) { /* ignore */ }
      }
      throw new Error('CANCELLED');
    }
  }

  // 1. Tạo thư mục output
  await mkdir(outputDir, { recursive: true });
  console.log(`${ts()} 📁 Output directory: ${outputDir}`);

  // ── 2. TẢI VIDEO VỚI YT-DLP ──────────────────────────────────────────
  let skipDownload = false;
  let videoTitle = null;

  // Kiểm tra source reuse
  if (request.source_id) {
    try {
      const srcSnap = await db.ref(`sources/${request.source_id}`).once('value');
      const srcData = srcSnap.val();
      if (srcData && srcData.file_path && existsSync(srcData.file_path)) {
        console.log(`${ts()} ♻️  Reusing existing source: ${srcData.file_path}`);
        // Copy/link reference
        const { copyFile } = await import('fs/promises');
        await copyFile(srcData.file_path, sourceFile);
        videoTitle = srcData.title;
        skipDownload = true;
        await pw.write({ step: 'downloading', step_num: 1, total_steps: 4, percent: 100,
          speed: null, eta: null, downloaded: `${srcData.file_size_mb} MB`, total_size: `${srcData.file_size_mb} MB`,
          current_file: 'source.mp4 (reused)' });
      }
    } catch (e) {
      console.log(`${ts()} ⚠️ Source reuse failed, downloading fresh: ${e.message}`);
    }
  }

  if (!skipDownload) {
    await assertNotCancelled();
    console.log(`${ts()} 📥 Downloading: ${request.url}`);
    await pw.write({ step: 'downloading', step_num: 1, total_steps: 4, percent: 0,
      speed: null, eta: null, downloaded: '0', total_size: 'calculating...',
      current_file: 'source.mp4' });

    const ytdlpArgs = [
      '--concurrent-fragments', String(config.settings?.concurrentFragments || 16),
      '--retries', '10',
      '--fragment-retries', '10',
      '--force-overwrites',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      '-f', 'bv*+ba/b',
      '--merge-output-format', 'mp4',
      '-o', sourceFile,
      '--no-playlist',
    ];

    // Cookies
    const cookiesFile = config.paths.cookiesFile;
    if (cookiesFile && existsSync(cookiesFile)) {
      ytdlpArgs.push('--cookies', cookiesFile);
    }

    // Live stream
    if (request.url && request.url.includes('/live/')) {
      ytdlpArgs.push('--live-from-start');
      console.log(`${ts()} 📡 Live stream detected — downloading from start`);
    }

    // Aria2c
    const ytdlpDir = path.dirname(config.paths.ytdlp);
    const aria2cPath = path.join(ytdlpDir, 'aria2c.exe');
    const useAria2c = existsSync(aria2cPath);

    if (useAria2c) {
      ytdlpArgs.push('--downloader', 'aria2c');
      ytdlpArgs.push('--downloader-args', 'aria2c:-x 16 -s 16 -j 16 -k 1M --allow-overwrite=true --auto-file-renaming=false');
      console.log(`${ts()} 🚀 Using aria2c (with --allow-overwrite fix)`);
    }

    ytdlpArgs.push(request.url);

    // Progress callback
    const onLine = (line) => {
      const prog = parseProgressLine(line);
      if (prog) {
        pw.write({ step: 'downloading', step_num: 1, total_steps: 4,
          percent: prog.percent || 0, speed: prog.speed, eta: prog.eta,
          downloaded: prog.downloaded || null, total_size: prog.total_size || null,
          current_file: 'source.mp4' });
      }
    };

    let downloadSuccess = false;
    try {
      await spawnAsync(config.paths.ytdlp, ytdlpArgs, {
        prefix: '[yt-dlp]', cwd: outputDir, onLine,
        onProc: (proc) => { currentProc = proc; }
      });
      downloadSuccess = true;
    } catch (err) {
      // Nếu aria2c fail, retry không dùng aria2c
      if (useAria2c && !err.message.includes('CANCELLED')) {
        console.log(`${ts()} ⚠️ aria2c failed, retrying without external downloader...`);
        await pw.write({ step: 'downloading', step_num: 1, total_steps: 4, percent: 0,
          speed: null, eta: 'retrying...', downloaded: '0', total_size: null,
          current_file: 'source.mp4 (retry)' });

        const retryArgs = ytdlpArgs.filter(a => a !== '--downloader' && a !== 'aria2c' && !a.startsWith('aria2c:'));
        // Remove downloader args pair
        const cleanArgs = [];
        for (let i = 0; i < retryArgs.length; i++) {
          if (retryArgs[i] === '--downloader-args') { i++; continue; }
          cleanArgs.push(retryArgs[i]);
        }

        await assertNotCancelled();
        await spawnAsync(config.paths.ytdlp, cleanArgs, {
          prefix: '[yt-dlp retry]', cwd: outputDir, onLine,
          onProc: (proc) => { currentProc = proc; }
        });
        downloadSuccess = true;
      } else {
        throw err;
      }
    }
    currentProc = null;

    // Verify source file
    if (!existsSync(sourceFile)) {
      throw new Error('Download completed but source.mp4 not found. Check yt-dlp output.');
    }
  }

  const sourceInfo = await stat(sourceFile);
  const sourceSizeMB = parseFloat((sourceInfo.size / 1024 / 1024).toFixed(1));
  console.log(`${ts()} ✅ Download complete: ${sourceSizeMB} MB`);

  await pw.write({ step: 'downloading', step_num: 1, total_steps: 4, percent: 100,
    speed: null, eta: null, downloaded: `${sourceSizeMB} MB`, total_size: `${sourceSizeMB} MB`,
    current_file: 'source.mp4' });

  // ── 3. CẮT SEGMENTS VỚI FFMPEG ───────────────────────────────────────
  const segments = request.segments || [];
  const highlightFiles = [];

  if (segments.length === 0) {
    console.log(`${ts()} ⚠️ No segments specified — skipping cut, using source file`);
    highlightFiles.push(sourceFile);
  } else {
    await assertNotCancelled();
    console.log(`${ts()} ✂️  Cutting ${segments.length} segment(s)...`);

    for (let i = 0; i < segments.length; i++) {
      await assertNotCancelled();

      const seg = segments[i];
      const startTag = timeTag(seg.start);
      const endTag = timeTag(seg.end);
      const datePart = (request.created_at || new Date().toISOString())
        .split('T')[0].replace(/-/g, '');
      const hlName = `HL_${datePart}_${startTag}-${endTag}.mp4`;
      const hlPath = path.join(outputDir, hlName);

      console.log(`${ts()} ✂️  [${i + 1}/${segments.length}] ${seg.start} → ${seg.end} → ${hlName}`);

      await pw.write({ step: 'cutting', step_num: 2, total_steps: 4,
        percent: Math.round(((i) / segments.length) * 100),
        speed: null, eta: null, current_file: hlName,
        cut_index: i + 1, cut_total: segments.length });

      const ffmpegArgs = [
        '-y', '-loglevel', 'error',
        '-ss', seg.start, '-to', seg.end,
        '-i', sourceFile,
        '-c', 'copy', '-avoid_negative_ts', 'make_zero',
        hlPath,
      ];

      await spawnAsync(config.paths.ffmpeg, ffmpegArgs, {
        prefix: '[ffmpeg]',
        onProc: (proc) => { currentProc = proc; }
      });
      currentProc = null;

      if (existsSync(hlPath)) {
        highlightFiles.push(hlPath);
      } else {
        console.warn(`${ts()} ⚠️ Segment ${i + 1} output not found: ${hlName}`);
      }
    }

    await pw.write({ step: 'cutting', step_num: 2, total_steps: 4, percent: 100,
      speed: null, eta: null, current_file: null,
      cut_index: segments.length, cut_total: segments.length });

    console.log(`${ts()} ✅ Cut complete: ${highlightFiles.length}/${segments.length} highlights`);
  }

  // ── 4. TÍNH TỔNG SIZE VÀ CHỌN PHƯƠNG THỨC GỬI ───────────────────────
  await assertNotCancelled();

  let totalSize = 0;
  for (const fp of highlightFiles) {
    const info = await stat(fp);
    totalSize += info.size;
  }
  const totalSizeMB = totalSize / (1024 * 1024);
  const maxEmailMB = config.settings?.maxFileSizeForEmailMB || 25;

  console.log(`${ts()} 📊 Total highlight size: ${totalSizeMB.toFixed(1)} MB (email limit: ${maxEmailMB} MB)`);

  let driveLinks = null;
  const resultLinks = [];

  if (totalSizeMB > maxEmailMB) {
    console.log(`${ts()} ☁️  Files too large for email — uploading to Google Drive...`);
    driveLinks = [];

    await pw.write({ step: 'uploading', step_num: 3, total_steps: 4, percent: 0,
      speed: null, eta: null, current_file: null });

    for (let i = 0; i < highlightFiles.length; i++) {
      await assertNotCancelled();
      const fp = highlightFiles[i];
      const fileName = path.basename(fp);
      try {
        await pw.write({ step: 'uploading', step_num: 3, total_steps: 4,
          percent: Math.round((i / highlightFiles.length) * 100),
          current_file: fileName });

        const { webViewLink } = await uploadToGoogleDrive(config, fp, fileName);
        driveLinks.push({ name: fileName, link: webViewLink });
        resultLinks.push(webViewLink);
      } catch (err) {
        console.error(`${ts()} ❌ Upload failed for ${fileName}: ${err.message}`);
        driveLinks.push({ name: fileName, link: `(upload failed: ${err.message})` });
      }
    }

    await pw.write({ step: 'uploading', step_num: 3, total_steps: 4, percent: 100 });
  } else {
    console.log(`${ts()} 📎 Files small enough — will attach to email`);
    await pw.write({ step: 'uploading', step_num: 3, total_steps: 4, percent: 100,
      speed: null, eta: null, current_file: 'skipped (attach to email)' });
    for (const fp of highlightFiles) {
      resultLinks.push(`file://${fp}`);
    }
  }

  // ── 5. GỬI EMAIL ─────────────────────────────────────────────────────
  await assertNotCancelled();

  if (request.email) {
    await pw.write({ step: 'emailing', step_num: 4, total_steps: 4, percent: 0,
      current_file: request.email });
    try {
      await sendResultEmail(config, request, highlightFiles, driveLinks);
      await pw.write({ step: 'emailing', step_num: 4, total_steps: 4, percent: 100 });
    } catch (err) {
      console.error(`${ts()} ❌ Email send failed: ${err.message}`);
    }
  } else {
    console.log(`${ts()} ⚠️ No email address — skipping email`);
    await pw.write({ step: 'emailing', step_num: 4, total_steps: 4, percent: 100,
      current_file: 'skipped' });
  }

  // ── 6. XÓA SOURCE FILE (giữ highlight cho cleanup sau) ───────────────
  if (segments.length > 0) {
    try {
      await unlink(sourceFile);
      console.log(`${ts()} 🗑️  Deleted source file to save space`);
    } catch { /* ignore */ }
  }

  await pw.flush();

  // ── 7. KẾT QUẢ ───────────────────────────────────────────────────────
  return {
    resultLinks,
    highlightCount: highlightFiles.length,
    totalSizeMB: parseFloat(totalSizeMB.toFixed(2)),
    sourceInfo: skipDownload ? null : {
      url: request.url,
      title: videoTitle || request.url,
      filePath: sourceFile,
      fileSizeMB: sourceSizeMB,
    },
  };
}
