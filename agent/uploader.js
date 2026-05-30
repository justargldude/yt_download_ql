// uploader.js — Upload file lên Google Drive bằng service account
import { google } from 'googleapis';
import { readFile } from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ts } from './agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tạo Drive client từ service account.
 */
async function getDriveClient(config) {
  const saPath = path.resolve(__dirname, config.google_drive.serviceAccountPath);
  const saRaw = await readFile(saPath, 'utf-8');
  const sa = JSON.parse(saRaw);

  const auth = new google.auth.GoogleAuth({
    credentials: sa,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  return google.drive({ version: 'v3', auth });
}

/**
 * Upload một file lên Google Drive shared folder.
 * @param {object} config - App config
 * @param {string} filePath - Đường dẫn file cần upload
 * @param {string} fileName - Tên file trên Drive
 * @returns {{ fileId: string, webViewLink: string }} Link xem file
 */
export async function uploadToGoogleDrive(config, filePath, fileName) {
  if (!config.google_drive?.serviceAccountPath || !config.google_drive?.folderId) {
    throw new Error('Google Drive not configured (missing serviceAccountPath or folderId)');
  }

  const drive = await getDriveClient(config);
  const folderId = config.google_drive.folderId;

  console.log(`${ts()} ☁️  Uploading to Google Drive: ${fileName}...`);

  // Tạo file trên Drive
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
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
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

  // Lấy lại webViewLink sau khi set permission
  const fileInfo = await drive.files.get({
    fileId,
    fields: 'webViewLink',
  });

  const webViewLink = fileInfo.data.webViewLink;
  console.log(`${ts()} ✅ Uploaded: ${fileName} → ${webViewLink}`);

  return { fileId, webViewLink };
}

/**
 * Xóa file trên Google Drive theo ID.
 * @param {object} config - App config
 * @param {string} fileId - Drive file ID
 */
export async function deleteFromDrive(config, fileId) {
  try {
    const drive = await getDriveClient(config);
    await drive.files.delete({ fileId });
    console.log(`${ts()} 🗑️  Deleted from Drive: ${fileId}`);
  } catch (err) {
    console.warn(`${ts()} ⚠️ Failed to delete Drive file ${fileId}: ${err.message}`);
  }
}
