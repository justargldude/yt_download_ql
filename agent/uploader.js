// uploader.js — Upload file lên Google Drive bằng OAuth2 (dùng quota của bạn)
// Hỗ trợ cả OAuth2 (cá nhân) và Service Account (fallback)
import { google } from 'googleapis';
import { readFile, writeFile } from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ts } from './agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tạo Drive client — ưu tiên OAuth2, fallback Service Account.
 */
async function getDriveClient(config) {
  const driveConfig = config.google_drive;

  // ── OAuth2 (dùng quota Google One của user) ──
  if (driveConfig.clientId && driveConfig.clientSecret && driveConfig.refreshToken) {
    const oauth2 = new google.auth.OAuth2(
      driveConfig.clientId,
      driveConfig.clientSecret,
    );
    oauth2.setCredentials({ refresh_token: driveConfig.refreshToken });
    return google.drive({ version: 'v3', auth: oauth2 });
  }

  // ── Service Account (fallback) ──
  if (driveConfig.serviceAccountPath) {
    const saPath = path.resolve(__dirname, driveConfig.serviceAccountPath);
    const sa = JSON.parse(await readFile(saPath, 'utf-8'));
    const auth = new google.auth.GoogleAuth({
      credentials: sa,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    return google.drive({ version: 'v3', auth });
  }

  throw new Error('Google Drive not configured: need OAuth2 (clientId/clientSecret/refreshToken) or serviceAccountPath');
}

/**
 * Upload một file lên Google Drive.
 */
export async function uploadToGoogleDrive(config, filePath, fileName) {
  const driveConfig = config.google_drive;
  if (!driveConfig?.folderId) {
    throw new Error('Google Drive not configured (missing folderId)');
  }

  const drive = await getDriveClient(config);

  console.log(`${ts()} ☁️  Uploading: ${fileName}...`);

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [driveConfig.folderId],
    },
    media: {
      mimeType: 'video/mp4',
      body: createReadStream(filePath),
    },
    fields: 'id, webViewLink',
  });

  const fileId = res.data.id;

  // Set quyền: ai có link đều xem được
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  const fileInfo = await drive.files.get({ fileId, fields: 'webViewLink' });
  const webViewLink = fileInfo.data.webViewLink;

  console.log(`${ts()} ✅ Uploaded: ${fileName} → ${webViewLink}`);
  return { fileId, webViewLink };
}

/**
 * Xóa file trên Drive.
 */
export async function deleteFromDrive(config, fileId) {
  try {
    const drive = await getDriveClient(config);
    await drive.files.delete({ fileId });
    console.log(`${ts()} 🗑️  Deleted: ${fileId}`);
  } catch (err) {
    console.warn(`${ts()} ⚠️ Delete failed: ${err.message}`);
  }
}
