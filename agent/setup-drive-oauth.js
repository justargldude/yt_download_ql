// setup-drive-oauth.js — Lấy refresh token cho Google Drive OAuth2
// Chạy 1 lần: node setup-drive-oauth.js
// Sau đó copy refresh_token vào config.json

import { google } from 'googleapis';
import { readFile, writeFile } from 'fs/promises';
import { createServer } from 'http';
import { URL } from 'url';
import { existsSync } from 'fs';

const CONFIG_FILE = './config.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const REDIRECT_PORT = 3456;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  🔐 Google Drive OAuth2 Setup');
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  // 1. Load config
  if (!existsSync(CONFIG_FILE)) {
    console.error('❌ config.json not found!');
    process.exit(1);
  }

  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));

  if (!config.google_drive) {
    config.google_drive = {};
  }

  // 2. Check credentials
  if (!config.google_drive.clientId || !config.google_drive.clientSecret) {
    console.log('⚠️  Chưa có clientId/clientSecret trong config.json');
    console.log('');
    console.log('📋 Hướng dẫn tạo OAuth2 credentials:');
    console.log('');
    console.log('  1. Vào https://console.cloud.google.com/apis/credentials');
    console.log('  2. Chọn project "yt-highlight-queue"');
    console.log('  3. Bấm "CREATE CREDENTIALS" → "OAuth client ID"');
    console.log('  4. Application type: "Desktop app"');
    console.log('  5. Name: "YT Cut Agent"');
    console.log('  6. Bấm "CREATE"');
    console.log('  7. Copy Client ID và Client Secret');
    console.log('');
    console.log('  Sau đó thêm vào config.json → google_drive:');
    console.log('  {');
    console.log('    "google_drive": {');
    console.log('      "clientId": "YOUR_CLIENT_ID.apps.googleusercontent.com",');
    console.log('      "clientSecret": "YOUR_CLIENT_SECRET",');
    console.log('      "folderId": "YOUR_FOLDER_ID"');
    console.log('    }');
    console.log('  }');
    console.log('');
    console.log('  Rồi chạy lại: node setup-drive-oauth.js');
    console.log('');
    process.exit(1);
  }

  // 3. Create OAuth2 client
  const oauth2 = new google.auth.OAuth2(
    config.google_drive.clientId,
    config.google_drive.clientSecret,
    REDIRECT_URI,
  );

  // 4. Generate auth URL
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('📌 Bước 1: Mở link này trong trình duyệt:');
  console.log('');
  console.log(`  ${authUrl}`);
  console.log('');
  console.log('📌 Bước 2: Đăng nhập Google và cho phép quyền truy cập');
  console.log('📌 Bước 3: Đợi tự động hoàn tất...');
  console.log('');

  // 5. Start local server to catch the callback
  const code = await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code');
          if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>✅ Thành công!</h1><p>Bạn có thể đóng tab này.</p><script>window.close()</script>');
            server.close();
            resolve(code);
          } else {
            res.writeHead(400);
            res.end('Missing code parameter');
            reject(new Error('No code'));
          }
        }
      } catch (e) {
        reject(e);
      }
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`  ⏳ Đang đợi bạn đăng nhập... (listening on port ${REDIRECT_PORT})`);
    });

    setTimeout(() => {
      server.close();
      reject(new Error('Timeout — hết 5 phút chờ đăng nhập'));
    }, 300000);
  });

  // 6. Exchange code for tokens
  console.log('');
  console.log('  🔄 Đang lấy refresh token...');

  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    console.error('❌ Không nhận được refresh_token! Thử lại với prompt=consent.');
    process.exit(1);
  }

  console.log('  ✅ Lấy được refresh token!');
  console.log('');

  // 7. Save to config.json
  config.google_drive.refreshToken = tokens.refresh_token;

  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');

  console.log('═══════════════════════════════════════════════════');
  console.log('  ✅ ĐÃ LƯU refresh token vào config.json!');
  console.log('  ☁️  Google Drive upload sẽ dùng quota Google One của bạn');
  console.log('  🔄 Restart agent để áp dụng: chạy start.bat');
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  // 8. Quick test
  try {
    oauth2.setCredentials(tokens);
    const drive = google.drive({ version: 'v3', auth: oauth2 });
    const about = await drive.about.get({ fields: 'user, storageQuota' });
    const user = about.data.user;
    const quota = about.data.storageQuota;
    const usedGB = (parseInt(quota.usage) / 1073741824).toFixed(1);
    const totalGB = quota.limit ? (parseInt(quota.limit) / 1073741824).toFixed(0) : '∞';

    console.log(`  👤 Account: ${user.displayName} (${user.emailAddress})`);
    console.log(`  💾 Storage: ${usedGB} GB / ${totalGB} GB`);
    console.log('');
  } catch (e) {
    console.log(`  ⚠️ Test failed: ${e.message}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
