// dlib-upload-server.js - local upload endpoint for PTIT DLib PDFs
import http from 'http';
import { createWriteStream } from 'fs';
import { mkdir, rm } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

import { uploadToGoogleDrive } from './uploader.js';
import { ts } from './lib/logger.js';
import { isAllowedOrigin, createRateLimiter } from './lib/http-guards.js';

function getServerConfig(config) {
  const raw = config.dlib_upload || {};
  return {
    enabled: raw.enabled !== false,
    host: raw.host || '127.0.0.1',
    port: Number(raw.port || 8765),
    apiKey: raw.apiKey || '',
    maxUploadMB: Number(raw.maxUploadMB || 500),
    maxConcurrentUploads: Number(raw.maxConcurrentUploads || 2),
    uploadsPerMinute: Number(raw.uploadsPerMinute || 6),
    tempDir: raw.tempDir
      ? path.resolve(raw.tempDir)
      : path.join(config.paths.outputDir, 'dlib-uploads'),
    allowedOrigins: raw.allowedOrigins || [
      'https://dlib.ptit.edu.vn',
    ],
  };
}

// isAllowedOrigin moved to ./lib/http-guards.js (extension ids must be
// exact-allowlisted; prefix wildcard 'chrome-extension://' rejected).

function setCorsHeaders(req, res, cfg) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin, cfg.allowedOrigins)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,X-Filename,X-Doc-Id,X-Api-Key'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(req, res, cfg, statusCode, body) {
  setCorsHeaders(req, res, cfg);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function getHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function decodeHeaderValue(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizePdfName(name) {
  const fallback = 'dlib_document.pdf';
  const decoded = decodeHeaderValue(name || fallback);
  const base = path
    .basename(decoded)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  const safe = base || fallback;
  return safe.toLowerCase().endsWith('.pdf') ? safe : safe + '.pdf';
}

async function pipeRequestToFile(req, filePath, maxBytes) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const out = createWriteStream(filePath, { flags: 'wx' });

    function finish(err) {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(bytes);
    }

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        out.destroy();
        finish(new Error(`PDF is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
        return;
      }
      if (!out.write(chunk)) req.pause();
    });

    out.on('drain', () => req.resume());
    req.on('end', () => out.end());
    req.on('error', finish);
    out.on('error', finish);
    out.on('finish', () => finish());
  });
}

async function handleUpload(req, res, cfg, config, rateLimiter) {
  if (cfg.apiKey && getHeader(req, 'x-api-key') !== cfg.apiKey) {
    sendJson(req, res, cfg, 401, { ok: false, error: 'Invalid upload API key' });
    return;
  }

  // Rate limit: max N concurrent + M uploads/minute per remote IP
  const clientIp = req.socket?.remoteAddress || 'unknown';
  if (!rateLimiter.onBegin(clientIp)) {
    sendJson(req, res, cfg, 429, { ok: false, error: 'Too many uploads, try again shortly' });
    return;
  }

  // NOTE: từ đây mọi return path PHẢI đi qua finally để release slot
  try {
    const contentType = (getHeader(req, 'content-type') || '').toLowerCase();
    if (!contentType.startsWith('application/pdf')) {
      sendJson(req, res, cfg, 415, { ok: false, error: 'Expected application/pdf' });
      return;
    }

    const contentLength = Number(getHeader(req, 'content-length') || 0);
    const maxBytes = cfg.maxUploadMB * 1024 * 1024;
    if (contentLength > maxBytes) {
      sendJson(req, res, cfg, 413, {
        ok: false,
        error: `PDF is larger than ${cfg.maxUploadMB} MB`,
      });
      return;
    }

    await mkdir(cfg.tempDir, { recursive: true });
    const fileName = sanitizePdfName(getHeader(req, 'x-filename'));
    const tempPath = path.join(
      cfg.tempDir,
      `${Date.now()}-${crypto.randomUUID()}.pdf`
    );

    const bytes = await pipeRequestToFile(req, tempPath, maxBytes);
    if (bytes < 100) {
      throw new Error('PDF upload body is empty or too small');
    }

    const { fileId, webViewLink } = await uploadToGoogleDrive(
      config,
      tempPath,
      fileName,
      'application/pdf'
    );

    sendJson(req, res, cfg, 200, {
      ok: true,
      fileId,
      fileName,
      link: webViewLink,
      webViewLink,
    });
  } catch (err) {
    console.error(`${ts()} DLib upload failed: ${err.message}`);
    sendJson(req, res, cfg, 500, { ok: false, error: err.message });
  } finally {
    rateLimiter.onEnd(clientIp);  // luôn giải phóng slot — kể cả 415/413/500
    try {
      await rm(tempPath, { force: true });
    } catch {
      // ignore temp cleanup failures
    }
  }
}

export async function startDlibUploadServer(config) {
  const cfg = getServerConfig(config);
  if (!cfg.enabled) {
    console.log(`${ts()} DLib upload server disabled`);
    return null;
  }

  const rateLimiter = createRateLimiter({
    maxConcurrent: cfg.maxConcurrentUploads,
    perMinute: cfg.uploadsPerMinute,
  });

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, cfg.allowedOrigins)) {
      sendJson(req, res, cfg, 403, { ok: false, error: 'Origin not allowed' });
      return;
    }

    setCorsHeaders(req, res, cfg);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${cfg.host}:${cfg.port}`);

    if (req.method === 'GET' && url.pathname === '/dlib/health') {
      sendJson(req, res, cfg, 200, {
        ok: true,
        service: 'ptit-dlib-upload',
        driveConfigured: Boolean(config.google_drive?.folderId),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/dlib/upload') {
      await handleUpload(req, res, cfg, config, rateLimiter);
      return;
    }

    sendJson(req, res, cfg, 404, { ok: false, error: 'Not found' });
  });

  return await new Promise((resolve) => {
    server.once('error', (err) => {
      console.warn(`${ts()} DLib upload server failed to start: ${err.message}`);
      resolve(null);
    });

    server.listen(cfg.port, cfg.host, () => {
      console.log(
        `${ts()} DLib upload server listening on http://${cfg.host}:${cfg.port}/dlib/upload`
      );
      resolve(server);
    });
  });
}
