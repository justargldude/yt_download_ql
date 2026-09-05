// auth-checker.js — Kiểm tra cookies YouTube + Google Drive token khi khởi động
// Nếu cookies die → tự lấy lại từ Chrome browser
// Nếu Drive token die → thông báo + cố refresh
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';
import { ts } from './lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Augment PATH so yt-dlp's Python subprocess can find deno/quickjs
const AUGMENTED_ENV = {
  ...process.env,
  PATH: [
    path.join(process.env.HOME || '', '.deno', 'bin'),
    path.join(process.env.HOME || '', 'bin'),
    process.env.PATH || '',
  ].join(':'),
};

// ── SPAWN HELPER ────────────────────────────────────────────────────────
function runCommand(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env: AUGMENTED_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout?.on('data', c => { stdout += c.toString(); });
    proc.stderr?.on('data', c => { stderr += c.toString(); });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (e) {}
      resolve({ code: -1, stdout, stderr: stderr + '\n(timeout)' });
    }, timeoutMs);
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// ═════════════════════════════════════════════════════════════════════════
//  YOUTUBE COOKIES CHECK
// ═════════════════════════════════════════════════════════════════════════

const TEST_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo" — luôn tồn tại

/**
 * Kiểm tra cookies có hoạt động không.
 * @returns {'cookies'|'browser'|'none'} — mode nên dùng cho yt-dlp
 */
export async function checkYouTubeCookies(config) {
  const ytdlp = config.paths.ytdlp;
  const cookiesFile = config.paths.cookiesFile;

  console.log(`${ts()} 🔑 Kiểm tra YouTube authentication...`);

  // ── 1. Test cookies.txt ──
  if (cookiesFile && existsSync(cookiesFile)) {
    console.log(`${ts()}    📄 Cookies file: ${cookiesFile}`);
    try {
      const result = await runCommand(ytdlp, [
        '--force-ipv4',
        '--js-runtimes', 'deno', '--js-runtimes', 'quickjs',
        '--cookies', cookiesFile,
        '--skip-download', '--no-warnings', '-j',
        TEST_URL,
      ], 45000);

      if (result.code === 0 && result.stdout.includes('"id"')) {
        console.log(`${ts()}    ✅ Cookies OK — YouTube authenticated`);
        return 'cookies';
      }

      // Check nếu bị sign-in required
      const combined = result.stdout + result.stderr;
      if (/sign.?in|login|consent|cookie/i.test(combined)) {
        console.log(`${ts()}    ❌ Cookies EXPIRED — cần refresh`);
      } else if (result.code !== 0) {
        console.log(`${ts()}    ⚠️  Cookies test failed (code ${result.code})`);
      }
    } catch (err) {
      console.log(`${ts()}    ⚠️  Cookies test error: ${err.message}`);
    }
  } else {
    console.log(`${ts()}    📄 Không tìm thấy cookies file`);
  }

  // ── 2. Thử lấy từ Chrome browser ──
  console.log(`${ts()}    🔄 Thử lấy cookies từ Chrome...`);
  try {
    const result = await runCommand(ytdlp, [
      '--force-ipv4',
      '--js-runtimes', 'deno', '--js-runtimes', 'quickjs',
      '--cookies-from-browser', 'chrome',
      '--skip-download', '--no-warnings', '-j',
      TEST_URL,
    ], 25000);

    if (result.code === 0 && result.stdout.includes('"id"')) {
      console.log(`${ts()}    ✅ Chrome cookies OK — sẽ dùng --cookies-from-browser`);

      // Export cookies ra file để dùng lần sau (nhanh hơn đọc browser)
      await exportCookiesFromBrowser(ytdlp, cookiesFile);

      return 'browser';
    }

    console.log(`${ts()}    ❌ Chrome cookies cũng không hoạt động`);
    const combined = result.stdout + result.stderr;
    if (/no suitable.*(keyring|secretstorage)/i.test(combined)) {
      console.log(`${ts()}    💡 Chrome yêu cầu keyring/secretstorage — thử mở Chrome và đăng nhập YouTube`);
    }
  } catch (err) {
    console.log(`${ts()}    ⚠️  Chrome cookies error: ${err.message}`);
  }

  // ── 3. Không có authentication nào hoạt động ──
  console.log(`${ts()}    ⚠️  Không có YouTube auth — tải sẽ bị giới hạn hoặc lỗi`);
  return 'none';
}

/**
 * Export cookies từ Chrome browser ra cookies.txt file.
 */
async function exportCookiesFromBrowser(ytdlp, cookiesFile) {
  if (!cookiesFile) return;

  try {
    console.log(`${ts()}    💾 Đang export cookies từ Chrome → ${cookiesFile}...`);

    // yt-dlp --cookies-from-browser chrome --cookies cookies.txt --skip-download
    // Cách này dùng flag --cookies để ghi cookies (yt-dlp 2023.07+)
    const result = await runCommand(ytdlp, [
      '--force-ipv4',
      '--js-runtimes', 'deno', '--js-runtimes', 'quickjs',
      '--cookies-from-browser', 'chrome',
      '--cookies', cookiesFile,
      '--skip-download', '--no-warnings',
      TEST_URL,
    ], 25000);

    if (result.code === 0 && existsSync(cookiesFile)) {
      console.log(`${ts()}    ✅ Cookies exported thành công`);
    } else {
      console.log(`${ts()}    ⚠️  Export cookies failed — sẽ dùng trực tiếp từ browser`);
    }
  } catch (err) {
    console.log(`${ts()}    ⚠️  Export error: ${err.message}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  GOOGLE DRIVE CHECK
// ═════════════════════════════════════════════════════════════════════════

/**
 * Kiểm tra Google Drive access + quota.
 * @returns {{ ok: boolean, user?: string, usedGB?: string, totalGB?: string, error?: string }}
 */
export async function checkGoogleDrive(config) {
  const driveConfig = config.google_drive;

  console.log(`${ts()} ☁️  Kiểm tra Google Drive...`);

  if (!driveConfig?.folderId) {
    console.log(`${ts()}    ⚠️  Drive chưa cấu hình (thiếu folderId)`);
    return { ok: false, error: 'Thiếu folderId' };
  }

  // ── OAuth2 check ──
  if (driveConfig.clientId && driveConfig.clientSecret && driveConfig.refreshToken) {
    try {
      const oauth2 = new google.auth.OAuth2(
        driveConfig.clientId,
        driveConfig.clientSecret,
      );
      oauth2.setCredentials({ refresh_token: driveConfig.refreshToken });

      // Force refresh access token
      const { token } = await oauth2.getAccessToken();
      if (!token) throw new Error('Không lấy được access token');

      const drive = google.drive({ version: 'v3', auth: oauth2 });
      const about = await drive.about.get({ fields: 'user, storageQuota' });
      const user = about.data.user;
      const quota = about.data.storageQuota;
      const usedGB = (parseInt(quota.usage || 0) / 1073741824).toFixed(1);
      const totalGB = quota.limit ? (parseInt(quota.limit) / 1073741824).toFixed(0) : '∞';

      console.log(`${ts()}    ✅ Drive OK — ${user.displayName} (${user.emailAddress})`);
      console.log(`${ts()}    💾 Storage: ${usedGB} GB / ${totalGB} GB`);

      return { ok: true, user: user.emailAddress, usedGB, totalGB };
    } catch (err) {
      console.log(`${ts()}    ❌ Drive OAuth2 FAILED: ${err.message}`);

      // Thử re-generate refresh token nếu bị revoke
      if (/invalid_grant|token.*revoked|expired/i.test(err.message)) {
        console.log(`${ts()}    🔴 Refresh token đã hết hạn/bị thu hồi!`);
        console.log(`${ts()}    💡 Chạy lại: node setup-drive-oauth.js`);
        return { ok: false, error: 'Refresh token expired — cần chạy setup-drive-oauth.js' };
      }

      return { ok: false, error: err.message };
    }
  }

  // ── Service Account fallback ──
  if (driveConfig.serviceAccountPath) {
    try {
      const saPath = path.resolve(__dirname, driveConfig.serviceAccountPath);
      if (!existsSync(saPath)) {
        console.log(`${ts()}    ❌ Service account file không tồn tại: ${saPath}`);
        return { ok: false, error: 'Service account file missing' };
      }

      const { readFile } = await import('fs/promises');
      const sa = JSON.parse(await readFile(saPath, 'utf-8'));
      const auth = new google.auth.GoogleAuth({
        credentials: sa,
        scopes: ['https://www.googleapis.com/auth/drive'],
      });

      const drive = google.drive({ version: 'v3', auth });
      const about = await drive.about.get({ fields: 'user, storageQuota' });
      const user = about.data.user;
      console.log(`${ts()}    ✅ Drive OK (Service Account) — ${user.emailAddress}`);
      return { ok: true, user: user.emailAddress };
    } catch (err) {
      console.log(`${ts()}    ❌ Drive Service Account FAILED: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  console.log(`${ts()}    ⚠️  Drive chưa cấu hình (thiếu credentials)`);
  return { ok: false, error: 'Không có OAuth2 hoặc Service Account' };
}

// ═════════════════════════════════════════════════════════════════════════
//  COMBINED STARTUP CHECK
// ═════════════════════════════════════════════════════════════════════════

/**
 * Chạy toàn bộ kiểm tra khi agent khởi động.
 * @returns {{ ytMode: string, driveOk: boolean, driveError?: string }}
 */
export async function runStartupChecks(config) {
  console.log(`${ts()} ════════════════════════════════════════`);
  console.log(`${ts()} 🔍 KIỂM TRA QUYỀN TRUY CẬP`);
  console.log(`${ts()} ════════════════════════════════════════`);

  const ytMode = await checkYouTubeCookies(config);
  const driveResult = await checkGoogleDrive(config);

  console.log(`${ts()} ────────────────────────────────────────`);
  console.log(`${ts()} 📋 KẾT QUẢ:`);
  console.log(`${ts()}    YouTube: ${ytMode === 'cookies' ? '✅ cookies.txt' : ytMode === 'browser' ? '✅ Chrome browser' : '❌ Không có auth'}`);
  console.log(`${ts()}    Drive:   ${driveResult.ok ? '✅ OK' : '❌ ' + (driveResult.error || 'Failed')}`);
  console.log(`${ts()} ════════════════════════════════════════`);

  return {
    ytMode,
    driveOk: driveResult.ok,
    driveError: driveResult.error || null,
    driveUser: driveResult.user || null,
  };
}
