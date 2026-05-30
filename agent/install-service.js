// install-service.js — Cài đặt agent thành Windows Task Scheduler + tạo start.bat
import { exec } from 'child_process';
import { writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(__dirname, 'agent.js');
const batPath = path.join(__dirname, 'start.bat');

async function main() {
  console.log('📦 Installing YT-Queue-Agent...\n');

  // 1. Tạo start.bat để chạy thủ công
  const batContent = `@echo off
cd /d "%~dp0"
echo Starting YT-Queue-Agent...
node agent.js
pause
`;

  await writeFile(batPath, batContent, 'utf-8');
  console.log(`✅ Created start.bat at: ${batPath}`);

  // 2. Đăng ký Task Scheduler — tự chạy khi đăng nhập
  const taskName = 'YT-Queue-Agent';
  const nodePath = process.execPath; // Đường dẫn node.exe hiện tại
  const command = `schtasks /create /tn "${taskName}" /tr "\\"${nodePath}\\" \\"${agentPath}\\"" /sc ONLOGON /rl HIGHEST /f`;

  console.log(`\n📋 Registering Task Scheduler entry...`);
  console.log(`   Command: ${command}\n`);

  exec(command, (err, stdout, stderr) => {
    if (err) {
      console.error(`❌ Failed to register task: ${err.message}`);
      console.error('   💡 Try running this script as Administrator.');
      console.error(`   Or run manually: ${batPath}`);
      return;
    }

    if (stdout) console.log(stdout.trim());
    if (stderr) console.warn(stderr.trim());

    console.log(`\n✅ Task "${taskName}" registered successfully!`);
    console.log(`   The agent will auto-start on login.`);
    console.log(`   To start manually, double-click: ${batPath}`);
    console.log(`   To remove: schtasks /delete /tn "${taskName}" /f`);
  });
}

main().catch((err) => {
  console.error('❌ Install failed:', err.message);
  process.exit(1);
});
