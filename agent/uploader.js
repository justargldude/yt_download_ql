// uploader.js — Upload file lên Google Drive bằng OAuth2 (dùng quota của bạn)
// Hỗ trợ cả OAuth2 (cá nhân) và Service Account (fallback)
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import { google } from 'googleapis';
import { readFile } from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ts } from './agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tạo Drive client theo mode: 'oauth' hoặc 'sa'
 */
async function getDriveClient(config, useMode = 'oauth') {
  const driveConfig = config.google_drive;

  if (useMode === 'oauth' && driveConfig.clientId && driveConfig.clientSecret && driveConfig.refreshToken) {
    const oauth2 = new google.auth.OAuth2(
      driveConfig.clientId,
      driveConfig.clientSecret,
    );
    oauth2.setCredentials({ refresh_token: driveConfig.refreshToken });
    return google.drive({ version: 'v3', auth: oauth2 });
  }

  if (driveConfig.serviceAccountPath) {
    const saPath = path.resolve(__dirname, driveConfig.serviceAccountPath);
    if (existsSync(saPath)) {
      const sa = JSON.parse(await readFile(saPath, 'utf-8'));
      const auth = new google.auth.GoogleAuth({
        credentials: sa,
        scopes: ['https://www.googleapis.com/auth/drive'],
      });
      return google.drive({ version: 'v3', auth });
    }
  }

  throw new Error('Google Drive not configured properly.');
}

/**
 * Upload một file lên Google Drive.
 */
export async function uploadToGoogleDrive(config, filePath, fileName, mimeType = 'video/mp4') {
  const driveConfig = config.google_drive;
  if (!driveConfig?.folderId) {
    throw new Error('Google Drive not configured (missing folderId)');
  }

  console.log(`${ts()} ☁️  Uploading: ${fileName}...`);

  async function tryUpload(mode) {
    const drive = await getDriveClient(config, mode);
    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [driveConfig.folderId],
      },
      media: {
        mimeType,
        body: createReadStream(filePath),
      },
      fields: 'id, webViewLink',
    });

    const fileId = res.data.id;
    try {
      await drive.permissions.create({
        fileId,
        requestBody: { role: 'reader', type: 'anyone' },
      });
    } catch (permErr) { /* ignore permission error if SA can't share */ }

    const fileInfo = await drive.files.get({ fileId, fields: 'webViewLink' });
    return { fileId, webViewLink: fileInfo.data.webViewLink };
  }

  try {
    const result = await tryUpload('oauth');
    console.log(`${ts()} ✅ Uploaded (OAuth2): ${fileName} → ${result.webViewLink}`);
    return result;
  } catch (oauthErr) {
    console.warn(`${ts()} ⚠️ OAuth2 upload failed (${oauthErr.message}), trying Service Account fallback...`);
    try {
      const result = await tryUpload('sa');
      console.log(`${ts()} ✅ Uploaded (Service Account): ${fileName} → ${result.webViewLink}`);
      return result;
    } catch (saErr) {
      throw new Error(`Upload failed: OAuth2 (${oauthErr.message}) | SA (${saErr.message})`);
    }
  }
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
