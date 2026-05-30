// processor.js — Xử lý chính: tải video, cắt highlight, upload/gửi email
import { spawn } from 'child_process';
import { mkdir, stat, unlink, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { ts } from './agent.js';
import { sendResultEmail } from './emailer.js';
import { uploadToGoogleDrive } from './uploader.js';

/**
 * Chuyển timestamp '00:27:00' → '27m00s', '01:00:45' → '1h00m45s'
 */
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

/**
 * Wrapper cho child_process.spawn trả về Promise.
 * Stream stdout/stderr ra console với prefix.
 */
function spawnAsync(cmd, args, { prefix = '', cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, windowsHide: true });
    let stderrBuf = '';

    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          console.log(`${ts()} ${prefix} ${line}`);
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

/**
 * Xử lý một request từ Firebase.
 * @param {object} request - Request object (chứa url, segments, name, email, ...)
 * @param {string} requestId - Firebase key
 * @param {object} config - App config
 * @returns {{ resultLinks: string[], highlightCount: number, totalSizeMB: number }}
 */
export async function processRequest(request, requestId, config) {
  const outputDir = path.join(config.paths.outputDir, requestId);
  const sourceFile = path.join(outputDir, 'source.mp4');

  // 1. Tạo thư mục output
  await mkdir(outputDir, { recursive: true });
  console.log(`${ts()} 📁 Output directory: ${outputDir}`);

  // ── 2. TẢI VIDEO VỚI YT-DLP ──────────────────────────────────────────
  console.log(`${ts()} 📥 Downloading: ${request.url}`);

  const ytdlpArgs = [
    '--concurrent-fragments', String(config.settings?.concurrentFragments || 16),
    '--retries', '10',
    '--fragment-retries', '10',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    '-f', 'bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', sourceFile,
    '--no-playlist',
  ];

  // Cookies file (chống bot detection)
  const cookiesFile = config.paths.cookiesFile;
  if (cookiesFile && existsSync(cookiesFile)) {
    ytdlpArgs.push('--cookies', cookiesFile);
    console.log(`${ts()} 🍪 Using cookies file: ${cookiesFile}`);
  }

  // Live stream: download từ đầu
  if (request.url && request.url.includes('/live/')) {
    ytdlpArgs.push('--live-from-start');
    console.log(`${ts()} 📡 Live stream detected — downloading from start`);
  }

  // Aria2c accelerator (nếu có)
  const ytdlpDir = path.dirname(config.paths.ytdlp);
  const aria2cPath = path.join(ytdlpDir, 'aria2c.exe');
  if (existsSync(aria2cPath)) {
    ytdlpArgs.push('--downloader', 'aria2c');
    ytdlpArgs.push('--downloader-args', 'aria2c:-x 16 -s 16 -j 16 -k 1M');
    console.log(`${ts()} 🚀 Using aria2c for accelerated download`);
  }

  // URL cuối cùng
  ytdlpArgs.push(request.url);

  await spawnAsync(config.paths.ytdlp, ytdlpArgs, { prefix: '[yt-dlp]', cwd: outputDir });

  // Verify source file tồn tại
  if (!existsSync(sourceFile)) {
    throw new Error('Download completed but source.mp4 not found. Check yt-dlp output.');
  }

  const sourceInfo = await stat(sourceFile);
  console.log(`${ts()} ✅ Download complete: ${(sourceInfo.size / 1024 / 1024).toFixed(1)} MB`);

  // ── 3. CẮT SEGMENTS VỚI FFMPEG ───────────────────────────────────────
  const segments = request.segments || [];
  const highlightFiles = [];

  if (segments.length === 0) {
    console.log(`${ts()} ⚠️ No segments specified — skipping cut, using source file`);
    highlightFiles.push(sourceFile);
  } else {
    console.log(`${ts()} ✂️  Cutting ${segments.length} segment(s)...`);

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const startTag = timeTag(seg.start);
      const endTag = timeTag(seg.end);
      
      // Lấy dateTag YYYYMMDD từ request.created_at
      const datePart = (request.created_at || new Date().toISOString())
        .split('T')[0]
        .replace(/-/g, '');
      const hlName = `HL_${datePart}_${startTag}-${endTag}.mp4`;
      const hlPath = path.join(outputDir, hlName);

      console.log(`${ts()} ✂️  [${i + 1}/${segments.length}] ${seg.start} → ${seg.end} → ${hlName}`);

      const ffmpegArgs = [
        '-y',
        '-loglevel', 'error',
        '-ss', seg.start,
        '-to', seg.end,
        '-i', sourceFile,
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        hlPath,
      ];

      await spawnAsync(config.paths.ffmpeg, ffmpegArgs, { prefix: '[ffmpeg]' });

      if (existsSync(hlPath)) {
        highlightFiles.push(hlPath);
      } else {
        console.warn(`${ts()} ⚠️ Segment ${i + 1} output not found: ${hlName}`);
      }
    }

    console.log(`${ts()} ✅ Cut complete: ${highlightFiles.length}/${segments.length} highlights`);
  }

  // ── 4. TÍNH TỔNG SIZE VÀ CHỌN PHƯƠNG THỨC GỬI ───────────────────────
  let totalSize = 0;
  for (const fp of highlightFiles) {
    const info = await stat(fp);
    totalSize += info.size;
  }
  const totalSizeMB = totalSize / (1024 * 1024);
  const maxEmailMB = config.settings?.maxFileSizeForEmailMB || 20;

  console.log(`${ts()} 📊 Total highlight size: ${totalSizeMB.toFixed(1)} MB (email limit: ${maxEmailMB} MB)`);

  let driveLinks = null;
  const resultLinks = [];

  if (totalSizeMB > maxEmailMB) {
    // Upload lên Google Drive
    console.log(`${ts()} ☁️  Files too large for email — uploading to Google Drive...`);
    driveLinks = [];

    for (const fp of highlightFiles) {
      const fileName = path.basename(fp);
      try {
        const { webViewLink } = await uploadToGoogleDrive(config, fp, fileName);
        driveLinks.push({ name: fileName, link: webViewLink });
        resultLinks.push(webViewLink);
      } catch (err) {
        console.error(`${ts()} ❌ Upload failed for ${fileName}: ${err.message}`);
        driveLinks.push({ name: fileName, link: `(upload failed: ${err.message})` });
      }
    }
  } else {
    console.log(`${ts()} 📎 Files small enough — will attach to email`);
    for (const fp of highlightFiles) {
      resultLinks.push(`file://${fp}`);
    }
  }

  // ── 5. GỬI EMAIL ─────────────────────────────────────────────────────
  if (request.email) {
    try {
      await sendResultEmail(config, request, highlightFiles, driveLinks);
    } catch (err) {
      console.error(`${ts()} ❌ Email send failed: ${err.message}`);
      // Không throw — request vẫn coi là thành công nếu file sẵn sàng
    }
  } else {
    console.log(`${ts()} ⚠️ No email address — skipping email`);
  }

  // ── 6. XÓA SOURCE FILE (giữ highlight cho cleanup sau) ───────────────
  if (segments.length > 0) {
    try {
      await unlink(sourceFile);
      console.log(`${ts()} 🗑️  Deleted source file to save space`);
    } catch {
      // Không sao nếu xóa thất bại
    }
  }

  // ── 7. KẾT QUẢ ───────────────────────────────────────────────────────
  return {
    resultLinks,
    highlightCount: highlightFiles.length,
    totalSizeMB: parseFloat(totalSizeMB.toFixed(2)),
  };
}
