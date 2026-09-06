// lib/ytdlp-args.js — Pure yt-dlp argument builder (single source of truth).
// Extracted from processor.js so the "retry without aria2c" path can simply
// rebuild args with useAria2c:false instead of index-scanning the previous
// array for '--downloader'/'--downloader-args' flags (fragile when flags
// repeat or order changes).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * Build the yt-dlp download argv.
 * @param {object} o
 * @param {string}  o.url                Video URL (always last arg)
 * @param {string}  o.sourcePath          -o output path
 * @param {string} [o.ffmpegDir]         --ffmpeg-location dir
 * @param {boolean} [o.useAria2c]        Attach aria2c downloader
 * @param {string} [o.aria2cPath]        aria2c binary path
 * @param {boolean} [o.isLiveUrl]         Live-stream flags; live disables aria2c
 * @param {string} [o.ytdlpMode]          'cookies' | 'browser' | 'none'
 * @param {string} [o.cookiesFile]        cookies.txt path (mode 'cookies')
 * @param {boolean} [o.cookiesFileExists] Only attach --cookies when the file exists
 * @param {number} [o.concurrentFragments]
 * @param {boolean} [o.noContinue]        Append --no-continue (fresh retry)
 * @param {string} [o.ua]                 Custom user-agent
 * @returns {string[]} argv
 */
export function buildDownloadArgs({
  url,
  sourcePath,
  ffmpegDir,
  useAria2c = false,
  aria2cPath,
  isLiveUrl = false,
  ytdlpMode = 'cookies',
  cookiesFile,
  cookiesFileExists = true,
  concurrentFragments = 16,
  noContinue = false,
  ua = UA,
} = {}) {
  if (!url) throw new Error('buildDownloadArgs: url is required');

  const args = [
    '--force-ipv4',
    '--js-runtimes', 'deno', '--js-runtimes', 'quickjs',
    '--concurrent-fragments', String(concurrentFragments),
    '--retries', '10', '--fragment-retries', '10',
    '--user-agent', ua,
    '-f', 'bv*+ba/b', '--merge-output-format', 'mp4',
  ];

  if (ffmpegDir) args.push('--ffmpeg-location', ffmpegDir);
  args.push('-o', sourcePath, '--no-playlist');

  // YouTube auth: cookies file hoặc đọc từ browser
  if (ytdlpMode === 'browser') {
    args.push('--cookies-from-browser', 'chrome');
  } else if (ytdlpMode === 'cookies' && cookiesFile && cookiesFileExists) {
    args.push('--cookies', cookiesFile);
  }

  // Live stream: tải từ đầu, chờ nếu chưa bắt đầu, không giới hạn fragment
  if (isLiveUrl) {
    args.push('--live-from-start');
    args.push('--wait-for-video', '30-300');
    args.push('--no-part');
  }

  // aria2c không tương thích với live stream
  if (useAria2c && !isLiveUrl && aria2cPath) {
    args.push('--downloader', aria2cPath);
    args.push('--downloader-args', 'aria2c:-x 16 -s 16 -j 16 -k 1M --allow-overwrite=true --auto-file-renaming=false --disable-ipv6=true --async-dns-server=8.8.8.8,1.1.1.1');
  }

  if (noContinue) args.push('--no-continue');

  args.push(url);
  return args;
}
