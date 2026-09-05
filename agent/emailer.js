// emailer.js — v4.3: Professional email format, date in subject
import nodemailer from 'nodemailer';
import path from 'path';
import { stat } from 'fs/promises';
import { ts } from './lib/logger.js';
import { escapeHtml } from './lib/escape.js';

export { escapeHtml };

function createTransporter(config) {
  return nodemailer.createTransport({
    service: config.email.service || 'gmail',
    auth: { user: config.email.user, pass: config.email.appPassword },
  });
}

/**
 * Format ngày gọn: "02/06" hoặc "02/06/2026"
 */
function formatDate(isoString) {
  const d = isoString ? new Date(isoString) : new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

/**
 * Gửi email kết quả. Tự batch nếu tổng > maxEmailMB.
 */
export async function sendResultEmail(config, request, highlightFiles, driveLinks) {
  if (!config.email?.user || !config.email?.appPassword) {
    console.warn(`${ts()} Email not configured, skipping.`);
    return;
  }

  const transporter = createTransporter(config);
  const maxEmailMB = config.settings?.maxFileSizeForEmailMB || 25;
  const shouldAttach = !driveLinks;
  const oversizedFiles = [];

  if (shouldAttach && highlightFiles.length > 0) {
    let totalMB = 0;
    const fileSizes = [];
    for (const fp of highlightFiles) {
      const info = await stat(fp);
      const sizeMB = info.size / (1024 * 1024);
      fileSizes.push({ path: fp, sizeMB });
      totalMB += sizeMB;
    }

    if (totalMB > maxEmailMB) {
      console.log(`${ts()} Total ${totalMB.toFixed(1)} MB > ${maxEmailMB} MB — batching`);
      const batches = [];
      let currentBatch = [], currentSize = 0;

      for (const file of fileSizes) {
        if (file.sizeMB > maxEmailMB) {
          if (currentBatch.length > 0) { batches.push(currentBatch); currentBatch = []; currentSize = 0; }
          oversizedFiles.push(file);
          console.log(`${ts()} File ${path.basename(file.path)} (${file.sizeMB.toFixed(1)} MB) exceeds limit — noted`);
          continue;
        }
        if (currentSize + file.sizeMB > maxEmailMB && currentBatch.length > 0) {
          batches.push(currentBatch); currentBatch = []; currentSize = 0;
        }
        currentBatch.push(file);
        currentSize += file.sizeMB;
      }
      if (currentBatch.length > 0) batches.push(currentBatch);

      console.log(`${ts()} Sending ${batches.length} email(s)...`);
      for (let b = 0; b < batches.length; b++) {
        const batchFiles = batches[b].map(f => f.path);
        const batchLabel = batches.length > 1 ? ` (${b + 1}/${batches.length})` : '';
        await sendSingleEmail(transporter, config, request, batchFiles, null, batchLabel, highlightFiles, oversizedFiles);
        console.log(`${ts()} Batch ${b + 1}/${batches.length} sent`);
      }
      return;
    }
  }

  await sendSingleEmail(transporter, config, request, highlightFiles, driveLinks, '', highlightFiles, oversizedFiles);
}

/**
 * Gửi 1 email — format chuyên nghiệp, không spam icon.
 */
async function sendSingleEmail(transporter, config, request, attachFiles, driveLinks, batchLabel, allFiles, oversizedFiles = []) {
  const segments = request.segments || [];
  const dateStr = formatDate(request.created_at);
  const fromName = config.email.fromName || 'YT Cut';

  // Bảng segments (hoặc full video info)
  const isFullDownload = segments.length === 0;
  const attachBasenames = new Set(attachFiles.map(fp => path.basename(fp)));
  let segmentTableHtml = '';

  if (!isFullDownload) {
    const segmentRows = safeSegments.map((seg, i) => {
      const fileName = allFiles[i] ? escapeHtml(path.basename(allFiles[i])) : '—';
      const inBatch = attachBasenames.has(allFiles[i] ? path.basename(allFiles[i]) : '');
      const bgColor = inBatch ? '#f0f7f0' : '#fff';
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;background:${bgColor}">${i + 1}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;background:${bgColor}">${seg.start}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;background:${bgColor}">${seg.end}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;background:${bgColor}">${fileName}</td>
      </tr>`;
    }).join('\n');

    segmentTableHtml = `
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <thead>
          <tr style="background:#f8f9fa">
            <th style="padding:8px 12px;text-align:center;font-size:13px;color:#666;border-bottom:2px solid #dee2e6">#</th>
            <th style="padding:8px 12px;text-align:left;font-size:13px;color:#666;border-bottom:2px solid #dee2e6">Start</th>
            <th style="padding:8px 12px;text-align:left;font-size:13px;color:#666;border-bottom:2px solid #dee2e6">End</th>
            <th style="padding:8px 12px;text-align:left;font-size:13px;color:#666;border-bottom:2px solid #dee2e6">File</th>
          </tr>
        </thead>
        <tbody>${segmentRows}</tbody>
      </table>`;
  } else {
    const fileName = allFiles[0] ? escapeHtml(path.basename(allFiles[0])) : 'video';
    segmentTableHtml = `
      <div style="background:#f0f7f0;padding:12px 16px;border-radius:6px;margin-bottom:20px">
        <p style="margin:0;font-weight:600">📹 Full video download</p>
        <p style="margin:4px 0 0;color:#555;font-size:14px">${fileName}</p>
      </div>`;
  }

  // Delivery section
  let deliveryHtml = '';
  if (driveLinks && driveLinks.length > 0) {
    const links = driveLinks.map(d =>
      `<li style="margin:4px 0"><a href="${escapeHtml(d.link)}" style="color:#1a73e8;text-decoration:none">${escapeHtml(d.name)}</a></li>`
    ).join('\n');
    deliveryHtml = `
      <p style="font-weight:600;margin-bottom:8px">Download:</p>
      <ul style="padding-left:20px;margin:0">${links}</ul>
    `;
  } else {
    const count = attachFiles.length;
    deliveryHtml = `<p>${count} file${count !== 1 ? 's' : ''} đính kèm trong email này.</p>`;
  }

  if (batchLabel) {
    deliveryHtml += `<p style="color:#888;font-size:13px">Email${escapeHtml(batchLabel)}</p>`;
  }

  if (oversizedFiles.length > 0) {
    const names = oversizedFiles.map(f => `${escapeHtml(path.basename(f.path))} (${f.sizeMB.toFixed(0)} MB)`).join(', ');
    deliveryHtml += `<p style="color:#c62828;font-size:13px">File quá lớn cho email: ${names}. Vui lòng liên hệ chủ hệ thống để nhận qua Google Drive.</p>`;
  }

  // Truncate URL for display
  const displayUrl = request.url.length > 70 ? request.url.substring(0, 70) + '...' : request.url;

  // Escape mọi chuỗi user-controlled trước khi đưa vào HTML email
  const safeName = escapeHtml(request.name || 'there');
  const safeUrlAttr = escapeHtml(request.url);
  const safeDisplayUrl = escapeHtml(displayUrl);
  const safeSegments = (request.segments || []).map((s) => ({
    start: escapeHtml(s?.start ?? ''),
    end: escapeHtml(s?.end ?? ''),
  }));

  const html = `
<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
  <div style="padding:24px 0;border-bottom:2px solid #e0e0e0">
    <h2 style="margin:0;font-size:18px;font-weight:600;color:#222">
      Highlight clips — ${escapeHtml(dateStr)}${escapeHtml(batchLabel)}
    </h2>
  </div>

  <div style="padding:20px 0">
    <p style="margin:0 0 4px">Hi <strong>${safeName}</strong>,</p>
    <p style="margin:0 0 16px;color:#555">
      Clips from <a href="${safeUrlAttr}" style="color:#1a73e8;text-decoration:none">${safeDisplayUrl}</a>
    </p>

    ${segmentTableHtml}

    ${deliveryHtml}
  </div>

  <div style="padding:16px 0;border-top:1px solid #eee;color:#999;font-size:12px">
    ${escapeHtml(fromName)}
  </div>
</div>`;

  const attachments = driveLinks ? [] : attachFiles.map(fp => ({ filename: path.basename(fp), path: fp }));

  const subject = isFullDownload
    ? `Full recording ${dateStr}${batchLabel}`
    : `Highlights ${dateStr}${batchLabel} — ${segments.length} clip${segments.length !== 1 ? 's' : ''}`;

  await transporter.sendMail({
    from: `"${fromName}" <${config.email.user}>`,
    to: request.email,
    replyTo: config.email.user,
    subject,
    html,
    attachments,
  });

  console.log(`${ts()} Email sent to ${request.email}`);
}
