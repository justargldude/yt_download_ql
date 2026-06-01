// emailer.js — Gửi email kết quả qua Gmail SMTP (v4.0: batch support)
import nodemailer from 'nodemailer';
import path from 'path';
import { stat } from 'fs/promises';
import { ts } from './agent.js';

/**
 * Tạo Gmail SMTP transporter (tái sử dụng).
 */
function createTransporter(config) {
  return nodemailer.createTransport({
    service: config.email.service || 'gmail',
    auth: {
      user: config.email.user,
      pass: config.email.appPassword,
    },
  });
}

/**
 * Gửi email kết quả highlight cho người dùng.
 * Nếu file quá lớn cho 1 email → tự chia thành nhiều email.
 *
 * @param {object} config - App config
 * @param {object} request - Firebase request object
 * @param {string[]} highlightFiles - Mảng đường dẫn file highlight
 * @param {object[]|null} driveLinks - Mảng {name, link} nếu upload Drive, null nếu đính kèm
 */
export async function sendResultEmail(config, request, highlightFiles, driveLinks) {
  if (!config.email?.user || !config.email?.appPassword) {
    console.warn(`${ts()} ⚠️ Email not configured, skipping send.`);
    return;
  }

  const transporter = createTransporter(config);
  const maxEmailMB = config.settings?.maxFileSizeForEmailMB || 25;
  const shouldAttach = !driveLinks; // null = cần đính kèm

  // ── Tính tổng size nếu cần đính kèm ──
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
      // ── BATCH MODE: chia thành nhiều email ──
      console.log(`${ts()} 📧 Total ${totalMB.toFixed(1)} MB > ${maxEmailMB} MB — splitting into batches`);

      const batches = [];
      let currentBatch = [];
      let currentSize = 0;

      for (const file of fileSizes) {
        // Nếu 1 file đã > limit → gửi riêng
        if (file.sizeMB > maxEmailMB) {
          if (currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = [];
            currentSize = 0;
          }
          batches.push([file]);
          continue;
        }

        if (currentSize + file.sizeMB > maxEmailMB && currentBatch.length > 0) {
          batches.push(currentBatch);
          currentBatch = [];
          currentSize = 0;
        }
        currentBatch.push(file);
        currentSize += file.sizeMB;
      }
      if (currentBatch.length > 0) batches.push(currentBatch);

      console.log(`${ts()} 📧 Sending ${batches.length} email(s)...`);

      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const batchFiles = batch.map(f => f.path);
        const batchLabel = batches.length > 1 ? ` (${b + 1}/${batches.length})` : '';

        await sendSingleEmail(transporter, config, request, batchFiles, null, batchLabel, highlightFiles);
        console.log(`${ts()} ✅ Batch ${b + 1}/${batches.length} sent`);
      }
      return;
    }
  }

  // ── NORMAL MODE: 1 email ──
  await sendSingleEmail(transporter, config, request, highlightFiles, driveLinks, '', highlightFiles);
}

/**
 * Gửi 1 email.
 */
async function sendSingleEmail(transporter, config, request, attachFiles, driveLinks, batchLabel, allFiles) {
  const segments = request.segments || [];

  // Bảng segments — hiện TẤT CẢ segments, đánh dấu file nào đính kèm trong batch này
  const attachBasenames = new Set(attachFiles.map(fp => path.basename(fp)));
  const segmentRows = segments
    .map((seg, i) => {
      const fullFileName = allFiles[i] ? path.basename(allFiles[i]) : '—';
      const inThisBatch = attachBasenames.has(fullFileName);
      const style = inThisBatch
        ? 'padding:6px 12px; border:1px solid #ddd; background:#e8f5e9;'
        : 'padding:6px 12px; border:1px solid #ddd;';
      return `<tr>
        <td style="${style} text-align:center;">${i + 1}</td>
        <td style="${style}">${seg.start || '—'}</td>
        <td style="${style}">${seg.end || '—'}</td>
        <td style="${style}">${fullFileName}${inThisBatch ? ' 📎' : ''}</td>
      </tr>`;
    })
    .join('\n');

  // Phần delivery
  let deliverySection = '';
  if (driveLinks && driveLinks.length > 0) {
    const linkItems = driveLinks
      .map((d) => `<li><a href="${d.link}">📥 ${d.name}</a></li>`)
      .join('\n');
    deliverySection = `
      <h3 style="color:#1a73e8;">📥 Download from Google Drive:</h3>
      <ul>${linkItems}</ul>
      <p style="color:#666; font-size:13px;">Files auto-delete after ${config.settings?.autoDeleteAfterHours || 24} hours.</p>
    `;
  }
  if (!driveLinks) {
    const fileCount = attachFiles.length;
    deliverySection += `
      <p>📎 <strong>${fileCount} highlight file${fileCount !== 1 ? 's' : ''} attached to this email.</strong></p>
    `;
  }

  if (batchLabel) {
    deliverySection += `<p style="color:#666; font-size:13px;">📦 This is email${batchLabel}</p>`;
  }

  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width:600px; margin:0 auto; padding:20px;">
      <h2 style="color:#d32f2f;">🎬 Your YouTube Highlights are ready!${batchLabel}</h2>
      <p>Hi <strong>${request.name || 'there'}</strong>!</p>
      <p>Your highlights from <a href="${request.url}">${request.url}</a> are ready.</p>

      <h3 style="color:#333;">📋 Segments</h3>
      <table style="border-collapse:collapse; width:100%; margin-bottom:16px;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:8px 12px; border:1px solid #ddd;">#</th>
            <th style="padding:8px 12px; border:1px solid #ddd;">Start</th>
            <th style="padding:8px 12px; border:1px solid #ddd;">End</th>
            <th style="padding:8px 12px; border:1px solid #ddd;">File</th>
          </tr>
        </thead>
        <tbody>
          ${segmentRows}
        </tbody>
      </table>

      ${deliverySection}

      <hr style="border:none; border-top:1px solid #eee; margin:24px 0;" />
      <p style="color:#999; font-size:12px;">Processed by ${config.email.fromName || 'YT Highlight Bot'} 🤖</p>
    </div>
  `;

  // Đính kèm file
  const attachments = driveLinks
    ? []
    : attachFiles.map((fp) => ({
        filename: path.basename(fp),
        path: fp,
      }));

  const mailOptions = {
    from: `"${config.email.fromName || 'YT Highlight Bot'}" <${config.email.user}>`,
    to: request.email,
    replyTo: config.email.user,
    subject: `🎬 Your YouTube Highlights are ready!${batchLabel}`,
    html,
    attachments,
  };

  console.log(`${ts()} 📧 Sending${batchLabel} to ${request.email} (${attachments.length} file(s))...`);
  await transporter.sendMail(mailOptions);
}
