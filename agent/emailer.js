// emailer.js — Gửi email kết quả qua Gmail SMTP
import nodemailer from 'nodemailer';
import path from 'path';
import { ts } from './agent.js';

/**
 * Gửi email kết quả highlight cho người dùng.
 * @param {object} config - App config
 * @param {object} request - Firebase request object (chứa name, email, url, segments)
 * @param {string[]} highlightFiles - Mảng đường dẫn file highlight
 * @param {object[]|null} driveLinks - Mảng {name, link} nếu upload Drive, null nếu đính kèm
 */
export async function sendResultEmail(config, request, highlightFiles, driveLinks) {
  if (!config.email?.user || !config.email?.appPassword) {
    console.warn(`${ts()} ⚠️ Email not configured, skipping send.`);
    return;
  }

  // Tạo transporter Gmail SMTP
  const transporter = nodemailer.createTransport({
    service: config.email.service || 'gmail',
    auth: {
      user: config.email.user,
      pass: config.email.appPassword,
    },
  });

  // Xây dựng bảng segments
  const segments = request.segments || [];
  const segmentRows = segments
    .map((seg, i) => {
      const fileName = highlightFiles[i] ? path.basename(highlightFiles[i]) : '—';
      return `<tr>
        <td style="padding:6px 12px; border:1px solid #ddd; text-align:center;">${i + 1}</td>
        <td style="padding:6px 12px; border:1px solid #ddd;">${seg.start || '—'}</td>
        <td style="padding:6px 12px; border:1px solid #ddd;">${seg.end || '—'}</td>
        <td style="padding:6px 12px; border:1px solid #ddd;">${fileName}</td>
      </tr>`;
    })
    .join('\n');

  // Phần delivery: đính kèm hoặc link Drive
  let deliverySection = '';
  if (driveLinks && driveLinks.length > 0) {
    const linkItems = driveLinks
      .map((d) => `<li><a href="${d.link}">${d.name}</a></li>`)
      .join('\n');
    deliverySection = `
      <h3 style="color:#1a73e8;">📥 Download your files:</h3>
      <ul>${linkItems}</ul>
      <p style="color:#666; font-size:13px;">Links will remain active. Files auto-delete from the server after ${config.settings?.autoDeleteAfterHours || 24} hours.</p>
    `;
  } else {
    deliverySection = `
      <p>📎 <strong>Files are attached to this email.</strong></p>
    `;
  }

  // HTML body
  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width:600px; margin:0 auto; padding:20px;">
      <h2 style="color:#d32f2f;">🎬 Your YouTube Highlights are ready!</h2>
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

  // Đính kèm file nếu không upload Drive
  const attachments = driveLinks
    ? []
    : highlightFiles.map((fp) => ({
        filename: path.basename(fp),
        path: fp,
      }));

  const mailOptions = {
    from: `"${config.email.fromName || 'YT Highlight Bot'}" <${config.email.user}>`,
    to: request.email,
    replyTo: config.email.user,
    subject: '🎬 Your YouTube Highlights are ready!',
    html,
    attachments,
  };

  console.log(`${ts()} 📧 Sending email to ${request.email}...`);
  await transporter.sendMail(mailOptions);
  console.log(`${ts()} ✅ Email sent successfully to ${request.email}`);
}
