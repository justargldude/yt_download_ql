# YT Highlight Queue — Hướng dẫn cài đặt (Windows / Linux / macOS)

Hệ thống cho phép bất kỳ ai gửi yêu cầu tải + cắt highlight YouTube qua web.
Khi PC bạn bật, agent chạy trên máy bạn tự động xử lý và gửi kết quả qua email.

## Kiến trúc

```
[Người gửi] → [Web Form (GitHub Pages/Netlify/Vercel)] → [Firebase RTDB] → [Agent trên PC bạn]
                                                            ↓
                                              [yt-dlp tải] → [ffmpeg cắt] → [Google Drive]
                                                            ↓
                                              [Email người gửi] + [Telegram cho bạn]
```

Tất cả xử lý diễn ra **trên máy bạn** (user-hosted) — web form chỉ là static site,
không có server trung tâm. Agent giữ mọi credentials (bot token, service account).

```
[Chrome Extension (ptit-dlib-downloader)] → [agent/dlib-upload-server.js :8765]
```

Extension upload PDF từ thư viện PTIT DLib về máy bạn, agent đẩy lên Google Drive.

---

## Bước 1: Tạo Firebase Project (5 phút)

1. Truy cập https://console.firebase.google.com
2. Click **"Create a project"** → đặt tên (VD: `yt-highlight-queue`)
3. Tắt Google Analytics → **Create Project**
4. Vào **Build → Realtime Database** → **Create Database**
5. Chọn region gần nhất (Singapore) → **Start in test mode** → Enable
6. Copy **Database URL** (dạng: `https://yt-highlight-queue-default-rtdb.asia-southeast1.firebasedatabase.app`)

### Cấu hình Rules cho Database (Quan trọng):
Để tránh lỗi ghi dữ liệu bị chặn sau 30 ngày (hết hạn test mode) và bảo mật dữ liệu:
1. Vào tab **Rules** ở trên cùng trang Realtime Database.
2. Thay thế nội dung bằng đoạn dưới đây và nhấn **Publish**:
```json
{
  "rules": {
    "requests": {
      "$request_id": {
        ".read": "true",
        ".write": "!data.exists()"
      }
    },
    "notifications": {
      "$push_id": {
        ".read": "false",
        ".write": "!data.exists()"
      }
    },
    "sources": {
      ".read": "false"
    }
  }
}
```
*(Local Agent chạy bằng Service Account có quyền Admin nên vẫn đọc/ghi bình thường.
Rule `notifications` cho phép client push thông báo mới nhưng không đọc/xóa queue của người khác.)*

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
    "ytdlp": "yt-dlp",
    "ffmpeg": "ffmpeg",
    "outputDir": "~/YT_Queue_Output",
    "cookiesFile": "~/cookies.txt"
  }
}
```

**Lưu ý:**
- `"ytdlp": "yt-dlp"` và `"ffmpeg": "ffmpeg"` — chỉ cần 2 program này nằm trên `PATH`.
  Đường dẫn tuyệt đối (VD: `C:\tools\yt-dlp.exe`) cũng hoạt động.
- `~` được tự động mở rộng thành home directory trên cả Windows (`C:\Users\<you>`) lẫn Linux/macOS.
- Nếu tải YouTube bị yêu cầu đăng nhập: đặt file cookies (Netscape format) vào đường dẫn
  `cookiesFile`, hoặc đặt `"ytdlp_mode": "browser"` để đọc cookies trực tiếp từ Chrome.

---

## Bước 6: Cài đặt và chạy Agent

### Cài tools cần thiết:

**Linux (Ubuntu/Debian):**
```bash
sudo apt update
sudo apt install -y ffmpeg aria2 nodejs npm
# yt-dlp
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp
```

**Windows:**
```powershell
winget install yt-dlp.yt-dlp Gyan.FFmpeg aria2.aria2
# Node.js LTS từ https://nodejs.org (nếu chưa có)
```

**macOS:**
```bash
brew install yt-dlp ffmpeg aria2 node
```

*(aria2c là tùy chọn — nếu thiếu, agent tự dùng native downloader của yt-dlp.)*

### Chạy Agent:
```bash
cd agent
npm install
node agent.js
```

### Chạy với auto-restart:

**Linux/macOS:**
```bash
./start-agent.sh
```

**Windows:**
```cmd
start-agent.bat
```

*(Cả 2 script đều restart agent sau 10s nếu crash; exit code 0 = shutdown sạch, không restart.)*

### Tự động chạy khi bật PC:

**Linux (systemd user service):**
```bash
node install-service.js
```
Lệnh trên tạo systemd user service, agent tự khởi động khi login và tự restart khi crash:
```bash
systemctl --user status yt-queue-agent     # Xem trạng thái
systemctl --user restart yt-queue-agent    # Restart agent
systemctl --user stop yt-queue-agent       # Dừng agent
journalctl --user -u yt-queue-agent -f     # Xem logs real-time
systemctl --user disable yt-queue-agent    # Tắt auto-start
```

**Windows (Task Scheduler):**
Script in hướng dẫn tạo task `schtasks` chạy `start-agent.bat` khi login — xem output
của `node install-service.js` trên Windows.

---

## Bước 7: Deploy Web Form

**Trước khi deploy:** copy `web/config.example.js` → `web/config.js`, điền `firebaseConfig`
(từ Bước 1). **KHÔNG bao giờ** để bot token/secret nào trong `web/config.js` — web client
chỉ cần Firebase config (dữ liệu public); mọi thông báo cho chủ hệ thống đi qua hàng đợi
`notifications/` trong RTDB mà agent consume.

```js
window.YT_WEB_CONFIG = {
  firebase: {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT.firebaseapp.com",
    databaseURL: "https://YOUR_PROJECT-xxx.firebasedatabase.app",
    projectId: "YOUR_PROJECT",
  },
};
```

### Option A: GitHub Pages (khuyến nghị - luôn online)
1. Tạo repo mới trên GitHub
2. Upload thư mục `web/` lên repo (NHỚ thêm `web/config.js` vào `.gitignore`)
3. Vào **Settings → Pages → Source: main branch → /web folder**
4. Web form sẽ có URL: `https://username.github.io/repo-name/`

### Option B: Netlify (kéo thả)
1. Truy cập https://app.netlify.com
2. Kéo thả thư mục `web/` vào
3. Done!

### Option C: Vercel
1. Đẩy toàn bộ repo lên GitHub.
2. Truy cập https://vercel.com và đăng nhập.
3. Nhấp **Add New → Project** và import repository.
4. Giữ nguyên cấu hình mặc định (`vercel.json` đã trỏ vào `web/`) → **Deploy**.

---

## Extension: PTIT DLib Downloader (Chrome)

Upload PDF từ thư viện số PTIT DLib về máy bạn rồi lên Google Drive.

1. Mở `chrome://extensions` → bật **Developer mode**
2. **Load unpacked** → chọn thư mục `ptit-dlib-downloader/`
3. Mở popup extension → điền **Upload endpoint** (VD: `http://127.0.0.1:8765/dlib/upload`)
   và **API key** (khớp với `dlib_upload.apiKey` trong `agent/config.json`)
4. Mở trang PDF trên DLib → nút upload xuất hiện

Endpoint này chỉ nghe trên `127.0.0.1` — không lộ ra internet. Origin được
allowlist chính xác (extension id phải khớp), mỗi IP tối đa 2 upload đồng thời
+ 6 upload/phút.

---

## Chạy tests

```bash
node --test tests/
```

78 tests covering: URL parsing/dedup hash, HTML escaping, path utilities,
process-tree kill, config loading + installers, dedup chaining, yt-dlp args,
HTTP guards (origin allowlist + rate limiting), web app-utils, và regression
tests cho các bug từng bị QA bắt (TDZ, Map misuse, slot leak, XSS, injection).

---

## Cấu trúc thư mục

```
yt_download_ql/
├── web/                              ← Deploy lên GitHub Pages/Netlify/Vercel
│   ├── index.html                    ← Form + lịch sử (loads config.js → app-utils.js → app.js)
│   ├── style.css
│   ├── app.js                        ← Main UI logic
│   ├── app-utils.js                  ← YTUtils: parse/validate/escape/format helpers (pure)
│   ├── config.example.js            ← Template (copy → config.js, KHÔNG commit)
│   └── config.js                     ← [gitignored] firebaseConfig của bạn
├── agent/                            ← Chạy trên PC bạn (Win/Linux/macOS)
│   ├── agent.js                      ← Main loop: poll RTDB, dedup, defer, telegram, cleanup
│   ├── processor.js                  ← Download (yt-dlp) + cut (ffmpeg)
│   ├── emailer.js                    ← Gửi email (HTML-escaped)
│   ├── uploader.js                   ← Upload Google Drive
│   ├── telegram.js                   ← Gửi Telegram + consume /notifications queue
│   ├── dlib-upload-server.js         ← HTTP endpoint cho DLib extension (origin+rate limited)
│   ├── cleanup.js                    ← Xóa file nguồn cũ (12h retention)
│   ├── config-loader.js              ← Load config + defaults (~ expansion)
│   ├── auth-checker.js               ← Verify credentials lúc boot
│   ├── install-service.js            ← systemd service (Linux) / schtasks guidance (Windows)
│   ├── start-agent.sh                ← Auto-restart runner (Linux/macOS)
│   ├── start-agent.bat               ← Auto-restart runner (Windows)
│   ├── setup-drive-oauth.js
│   ├── lib/                          ← Shared modules (pure, testable)
│   │   ├── logger.js                 ← ts() timestamp
│   │   ├── url-hash.js               ← videoId/hash/normalizeURL (single source of truth)
│   │   ├── escape.js                 ← escapeHtml / escapeTelegram
│   │   ├── paths.js                  ← PATH augment, ~ expansion, isWindows
│   │   ├── proc.js                   ← killProcessTree (POSIX groups / taskkill)
│   │   ├── dedup.js                  ← duplicate-URL defer coordinator
│   │   ├── ytdlp-args.js             ← yt-dlp argv builder (pure)
│   │   └── http-guards.js            ← origin allowlist + rate limiter
│   ├── package.json
│   ├── config.example.json           ← Template (copy → config.json, KHÔNG commit)
│   ├── firebase-service-account.json ← [KHÔNG commit] Bạn tự thêm
│   └── gdrive-service-account.json   ← [KHÔNG commit] Bạn tự thêm
├── ptit-dlib-downloader/             ← Chrome extension (MV3)
│   ├── manifest.json / background.js / content.js
│   ├── popup.html / popup.js / popup.css
│   └── lib/
├── tests/                            ← node --test (78 tests)
└── README.md                         ← File này
```

## Bảo mật — tóm tắt

- **Secrets chỉ nằm trong `agent/config.json` + service account files** (đã gitignore).
  Web client không giữ bot token hay API key nào.
- Thông báo Telegram đi qua hàng đợi `notifications/` trong RTDB; agent escape
  mọi payload (parse_mode HTML) + rate limit 10 tin/phút + cap 50 pending.
- Email HTML: mọi trường user-controlled (name/url/filename/segments) được escape.
- dlib-upload-server: chỉ `127.0.0.1`, origin exact-allowlist, API key,
  max 2 concurrent + 6/phút per IP, max 500 MB.
- Web UI: mọi render path qua `escapeHtml`/`escapeAttr`; action buttons dùng
  event delegation (không inline onclick); URL validation strict `http(s)://`.
