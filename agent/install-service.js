// install-service.js — Cài đặt agent thành systemd user service + tạo start.sh
import { exec } from 'child_process';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(__dirname, 'agent.js');
const shPath = path.join(__dirname, 'start.sh');

async function main() {
  console.log('📦 Installing YT-Queue-Agent...\n');

  // ── Windows: không có systemd — hướng dẫn start-agent.bat + schtasks ──
  if (process.platform === 'win32') {
    console.log('🪟 Windows detected — systemd not available.\n');
    console.log('   1. Auto-restart foreground: chạy "start-agent.bat" trong thư mục agent.');
    console.log('   2. Tự khởi động khi login (tuỳ chọn), chạy với quyền user trong PowerShell:');
    console.log('      schtasks /create /tn "YT-Queue-Agent" /tr "< full path to >\\start-agent.bat" /sc onlogon');
    console.log('      (hoặc Task Scheduler GUI → Create Task → Trigger: At log on → Action: start.bat)');
    console.log('   3. Xoá task: schtasks /delete /tn "YT-Queue-Agent" /f');
    console.log('\n   Lưu ý: cần node, yt-dlp, ffmpeg trên PATH (winget install yt-dlp.yt-dlp / Gyan.FFmpeg).');
    return;
  }

  // 1. Tạo start.sh để chạy thủ công
  const shContent = `#!/usr/bin/env bash
# start.sh — Chạy agent với auto-restart khi crash
cd "$(dirname "$0")"

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting YT-Queue-Agent..."
  node agent.js
  EXIT_CODE=$?
  echo ""
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Agent stopped (exit code $EXIT_CODE). Restarting in 10 seconds..."
  echo "Press Ctrl+C to exit completely."
  sleep 10
done
`;

  await writeFile(shPath, shContent, { encoding: 'utf-8', mode: 0o755 });
  console.log(`✅ Created start.sh at: ${shPath}`);

  // 2. Tạo systemd user service — tự chạy khi đăng nhập
  const serviceName = 'yt-queue-agent';
  const nodePath = process.execPath; // Đường dẫn node hiện tại
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const systemdDir = path.join(homeDir, '.config', 'systemd', 'user');
  const serviceFile = path.join(systemdDir, `${serviceName}.service`);

  const serviceContent = `[Unit]
Description=YT-Queue Agent — YouTube Download Queue Processor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${__dirname}
ExecStart=${nodePath} "${agentPath}"
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;

  await mkdir(systemdDir, { recursive: true });
  await writeFile(serviceFile, serviceContent, 'utf-8');
  console.log(`✅ Created systemd service: ${serviceFile}`);

  // 3. Enable và start service
  console.log(`\n📋 Enabling and starting systemd service...`);

  const run = (cmd) => new Promise((resolve) => {
    exec(cmd, (err, stdout, stderr) => {
      if (stdout) console.log(stdout.trim());
      if (stderr && !stderr.includes('Created symlink')) console.warn(stderr.trim());
      resolve(!err);
    });
  });

  await run('systemctl --user daemon-reload');
  const enableOk = await run(`systemctl --user enable ${serviceName}`);
  const startOk = await run(`systemctl --user start ${serviceName}`);

  // 4. Enable lingering (để service chạy ngay cả khi chưa login GUI)
  const user = process.env.USER || process.env.LOGNAME;
  if (user) {
    console.log(`\n📋 Enabling linger for user ${user}...`);
    await run(`loginctl enable-linger ${user}`);
  }

  if (enableOk && startOk) {
    console.log(`\n✅ Service "${serviceName}" registered and started!`);
    console.log(`   The agent will auto-start on login.`);
    console.log(`   To start manually: ./start.sh`);
    console.log(`\n📋 Useful commands:`);
    console.log(`   systemctl --user status ${serviceName}    # Xem trạng thái`);
    console.log(`   systemctl --user restart ${serviceName}   # Restart agent`);
    console.log(`   systemctl --user stop ${serviceName}      # Dừng agent`);
    console.log(`   journalctl --user -u ${serviceName} -f    # Xem logs`);
    console.log(`   systemctl --user disable ${serviceName}   # Tắt auto-start`);
  } else {
    console.warn(`\n⚠️  Service registration might have issues.`);
    console.log(`   You can still run manually: ./start.sh`);
    console.log(`   Or try: systemctl --user status ${serviceName}`);
  }
}

main().catch((err) => {
  console.error('❌ Install failed:', err.message);
  process.exit(1);
});
