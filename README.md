# YT Highlight Queue - Hướng dẫn cài đặt (Ubuntu/Linux)

Hệ thống cho phép bất kỳ ai gửi yêu cầu tải + cắt highlight YouTube qua web.
Khi PC bạn bật, hệ thống tự động xử lý và gửi kết quả qua email.

## Kiến trúc

```
[Người gửi] → [Web Form (GitHub Pages)] → [Firebase Database] → [Ubuntu PC] → [Email cho người gửi]
                                                ↓
                                        [Telegram thông báo]
```

---

## Bước 1: Tạo Firebase Project (5 phút)

1. Truy cập https://console.firebase.google.com
2. Click **"Create a project"** → đặt tên (VD: `yt-highlight-queue`)
3. Tắt Google Analytics → **Create Project**
4. Vào **Build → Realtime Database** → **Create Database**
5. Chọn region gần nhất (Singapore) → **Start in test mode** → Enable
6. Copy **Database URL** (dạng: `https://yt-highlight-queue-default-rtdb.asia-southeast1.firebasedatabase.app`)

### Cấu hình Rules cho Database (Quan trọng):
Để tránh lỗi ghi dữ liệu bị chặn sau 30 ngày (hết hạn test mode) và bảo mật dữ liệu không cho người khác sửa/xóa yêu cầu cũ:
1. Vào tab **Rules** ở trên cùng trang Realtime Database.
2. Thay thế nội dung bằng đoạn dưới đây và nhấn **Publish**:
```json
{
  "rules": {
    "requests": {
      "$request_id": {
        // Cho phép bất kỳ ai đọc trạng thái và gửi yêu cầu mới (không ghi đè yêu cầu cũ)
        ".read": "true",
        ".write": "!data.exists()"
      }
    }
  }
}
```
*(Ghi chú: Local Agent chạy bằng Service Account có quyền Admin tối cao nên vẫn cập nhật trạng thái bình thường).*

### Lấy Web API Key:
1. Vào **Project Settings** (bánh răng ⚙️ góc trái)
2. Tab **General** → mục **Your apps** → click **</>** (Web)
3. Đặt tên app → Register → Copy đoạn `firebaseConfig`

### Tạo Service Account (cho Local Agent):
1. Vào **Project Settings → Service accounts**
2. Click **"Generate new private key"** → Download file JSON
3. Đổi tên thành `firebase-service-account.json`
4. Copy vào thư mục `agent/`

---

## Bước 2: Tạo Telegram Bot (3 phút)

1. Mở Telegram, tìm **@BotFather**
2. Gửi `/newbot` → đặt tên bot → đặt username
3. Copy **Bot Token** (dạng: `7123456789:AAH...`)
4. Mở bot của bạn, gửi `/start`
5. Truy cập: `https://api.telegram.org/bot<TOKEN>/getUpdates`
6. Tìm `"chat":{"id":123456789}` → đó là **Chat ID** của bạn

---

## Bước 3: Tạo Gmail App Password (2 phút)

1. Truy cập https://myaccount.google.com/apppasswords
2. Đăng nhập Gmail bạn muốn dùng để gửi email
3. Chọn **App:** Mail, **Device:** Other → đặt tên (VD: `YT Bot`)
4. Click **Generate** → Copy mật khẩu 16 ký tự (dạng: `abcd efgh ijkl mnop`)
5. **Lưu ý:** Cần bật 2-Step Verification trước

---

## Bước 4: Tạo Google Drive Service Account (5 phút)

Dùng cho upload file lớn.

1. Truy cập https://console.cloud.google.com
2. Chọn project đã tạo ở Bước 1 (hoặc tạo mới)
3. Vào **APIs & Services → Enable APIs** → tìm và bật **Google Drive API**
4. Vào **APIs & Services → Credentials → Create Credentials → Service Account**
5. Đặt tên → Create → Done
6. Click vào service account vừa tạo → **Keys → Add Key → JSON**
7. Download file JSON → đổi tên thành `gdrive-service-account.json` → copy vào `agent/`
8. Mở file JSON, copy email của service account (dạng: `xxx@yyy.iam.gserviceaccount.com`)

### Tạo shared folder trên Google Drive:
1. Mở Google Drive → tạo folder mới (VD: `YT Highlights`)
2. Right-click folder → Share → thêm email service account (từ bước 8) → Editor
3. Copy **Folder ID** từ URL: `https://drive.google.com/drive/folders/<FOLDER_ID>`

---

## Bước 5: Cấu hình Local Agent

1. Copy `config.example.json` → `config.json`
2. Điền tất cả thông tin đã lấy ở các bước trên:

```json
{
  "firebase": {
    "databaseURL": "https://YOUR_PROJECT-xxx.firebasedatabase.app",
    "serviceAccountPath": "./firebase-service-account.json"
  },
  "email": {
    "service": "gmail",
    "user": "your-email@gmail.com",
    "appPassword": "abcd efgh ijkl mnop"
  },
  "telegram": {
    "botToken": "7123456789:AAH...",
    "chatId": "123456789"
  },
  "google_drive": {
    "serviceAccountPath": "./gdrive-service-account.json",
    "folderId": "1abc..."
  },
  "paths": {
    "ytdlp": "/usr/bin/yt-dlp",
    "ffmpeg": "/usr/bin/ffmpeg",
    "outputDir": "~/YT_Queue_Output",
    "cookiesFile": "~/cookies.txt"
  }
}
```

---

## Bước 6: Cài đặt và chạy Agent

### Cài tools cần thiết:
```bash
# yt-dlp + ffmpeg + aria2c
sudo apt update
sudo apt install -y ffmpeg aria2
pip install yt-dlp    # hoặc: sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp
```

### Chạy Agent:
```bash
cd ~/yt-web-queue/agent
npm install
node agent.js
```

### Chạy với auto-restart:
```bash
./start.sh
```

### Tự động chạy khi bật PC (systemd service):
```bash
node install-service.js
```

Lệnh trên sẽ tạo systemd user service, agent tự khởi động khi login và tự restart khi crash.

Các lệnh quản lý hữu ích:
```bash
systemctl --user status yt-queue-agent     # Xem trạng thái
systemctl --user restart yt-queue-agent    # Restart agent
systemctl --user stop yt-queue-agent       # Dừng agent
journalctl --user -u yt-queue-agent -f     # Xem logs real-time
systemctl --user disable yt-queue-agent    # Tắt auto-start
```

---

## Bước 7: Deploy Web Form

### Option A: GitHub Pages (khuyến nghị - luôn online)
1. Tạo repo mới trên GitHub
2. Upload thư mục `web/` lên repo
3. Vào **Settings → Pages → Source: main branch → /web folder**
4. Web form sẽ có URL: `https://username.github.io/repo-name/`

### Option B: Netlify (kéo thả)
1. Truy cập https://app.netlify.com
2. Kéo thả thư mục `web/` vào
3. Done!

### Option C: Vercel (khuyên dùng cho tích hợp nhanh)
Vì đã có cấu hình file `vercel.json` ở thư mục gốc:
1. Đẩy toàn bộ thư mục `yt-web-queue` lên GitHub.
2. Truy cập https://vercel.com và đăng nhập.
3. Nhấp **Add New → Project** và import repository GitHub vừa đẩy lên.
4. Giữ nguyên mọi cấu hình mặc định và nhấn **Deploy**. Vercel sẽ tự nhận diện file `vercel.json` và trỏ website chính vào thư mục `web`.

### Quan trọng: Trước khi deploy
Mở file `web/app.js` và điền Firebase config + Telegram config vào phần CONFIG ở đầu file. (Hiện tại thông tin của bạn đã được điền sẵn đầy đủ và chính xác).

---

## Cấu trúc thư mục

```
yt-web-queue/
├── web/                          ← Deploy lên GitHub Pages
│   ├── index.html
│   ├── style.css
│   └── app.js
├── agent/                        ← Chạy trên Ubuntu PC
│   ├── agent.js                  ← Main loop
│   ├── processor.js              ← Download + cut
│   ├── emailer.js                ← Gửi email
│   ├── uploader.js               ← Upload Google Drive
│   ├── telegram.js               ← Gửi Telegram
│   ├── cleanup.js                ← Xóa file cũ
│   ├── config-loader.js          ← Load config
│   ├── install-service.js        ← Cài systemd service (auto-start)
│   ├── start.sh                  ← Chạy thủ công (auto-restart)
│   ├── package.json
│   ├── config.example.json       ← Template (copy → config.json)
│   ├── firebase-service-account.json  ← Bạn tự thêm
│   └── gdrive-service-account.json    ← Bạn tự thêm
├── push_to_github.sh             ← Đẩy code lên GitHub
├── start_tunnel.sh               ← Chạy ngrok tunnel cho DLib
└── README.md                     ← File này
```
