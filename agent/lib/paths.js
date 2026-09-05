// lib/paths.js — Cross-platform path/env helpers (single source of truth).
// Fixes: POSIX-only PATH join (':'), missing '~' expansion, HOME vs USERPROFILE.
import path from 'path';
import os from 'os';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This module lives in agent/lib/ — relative tool paths resolve against the
// agent root (parent of lib), matching where config.json paths are anchored.
const AGENT_DIR = path.resolve(__dirname, '..');

/** True when running on Windows. */
export function isWindows() {
  return process.platform === 'win32';
}

/**
 * Build an augmented copy of `baseEnv` with `extraDirs` prepended to PATH.
 * Uses path.delimiter (':' on POSIX, ';' on Windows). Empty/null entries
 * in extraDirs are filtered. Never mutates the input env.
 */
export function augmentPathEnv(extraDirs, baseEnv = process.env) {
  const dirs = (extraDirs || []).filter(Boolean);
  const base = (baseEnv && baseEnv.PATH) || '';
  const parts = [...dirs];
  if (base) parts.push(base);
  return { ...baseEnv, PATH: parts.filter(Boolean).join(path.delimiter) };
}

/**
 * Expand a leading '~' or '~/' to the user's homedir (os.homedir() works
 * on Windows too, unlike process.env.HOME). Returns the input unchanged
 * for absolute/relative/no-tilde paths; passes null/undefined through.
 */
export function resolveTilde(p) {
  if (p === null || p === undefined) return p;
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Normalize the config `paths` section:
 *  - outputDir / cookiesFile: expand '~' → homedir absolute.
 *  - ytdlp / ffmpeg: bare command names (e.g. 'yt-dlp', 'ffmpeg') stay
 *    as-is so spawn() resolves them via PATH on any OS; anything with a
 *    path separator is resolved to absolute (relative to the agent dir).
 * Returns a NEW object (deep clone of the paths section); input untouched.
 */
export function resolveConfigPaths(config) {
  const resolved = { ...(config || {}) };
  const paths = { ...((config && config.paths) || {}) };

  for (const key of ['outputDir', 'cookiesFile']) {
    if (paths[key] !== undefined) paths[key] = resolveTilde(paths[key]);
  }

  for (const key of ['ytdlp', 'ffmpeg']) {
    const val = paths[key];
    if (typeof val === 'string' && val) {
      if (val.includes('/') || val.includes('\\')) {
        // Path-like → make absolute relative to the agent directory
        if (!path.isAbsolute(val)) {
          paths[key] = path.resolve(AGENT_DIR, val);
        }
      }
      // Bare command name → leave for PATH lookup (yt-dlp, ffmpeg, aria2c…)
    }
  }

  resolved.paths = paths;
  return resolved;
}

/**
 * Directories worth prepending to PATH for yt-dlp's JS-runtime subprocesses
 * (deno/quickjs), cross-platform. Only existing dirs are returned.
 */
export function extraRuntimeDirs() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.deno', 'bin'),
    path.join(home, 'bin'),
  ];
  return candidates.filter((d) => existsSync(d));
}
