// lib/proc.js — Cross-platform process-tree control.
// POSIX: process groups (kill(-pid)) with SIGTERM→SIGKILL fallback.
// Windows: `taskkill /PID <pid> /T /F` (tree-kill, no process groups).
import { spawn } from 'child_process';
import { isWindows } from './paths.js';

/**
 * Kill an entire process tree. Accepts a ChildProcess (uses .pid) or a
 * numeric pid. Never throws — best-effort cleanup for shutdown/cancel
 * paths where throwing would mask the original error.
 */
export function killProcessTree(procOrPid) {
  let pid;
  if (typeof procOrPid === 'number' && Number.isFinite(procOrPid)) {
    pid = procOrPid;
  } else if (procOrPid && typeof procOrPid === 'object' && typeof procOrPid.pid === 'number') {
    pid = procOrPid.pid;
  } else {
    return; // garbage input — nothing to kill
  }
  if (!pid || pid <= 0) return;

  if (isWindows()) {
    // Windows has no process groups for detached spawn; taskkill /T walks
    // the child tree. Fire-and-forget with stdio ignore.
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
    } catch { /* best effort */ }
    // Belt-and-braces: direct kill on the handle if we got one
    if (procOrPid && typeof procOrPid.kill === 'function') {
      try { procOrPid.kill(); } catch { /* already dead */ }
    }
    return;
  }

  // POSIX: negative pid targets the whole process group (spawn detached)
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Group kill failed (permissions/pid reuse) → fall back to direct
    if (procOrPid && typeof procOrPid.kill === 'function') {
      try { procOrPid.kill('SIGKILL'); } catch { /* already dead */ }
    }
  }
}

/**
 * Standard spawn options for agent subprocesses (yt-dlp/ffmpeg/aria2c).
 * detached:true on POSIX creates a process group so killProcessTree can
 * reap the whole tree; windowsHide suppresses console flash on Windows.
 */
export function spawnOpts({ cwd, env, detached = true } = {}) {
  return {
    cwd,
    env,
    detached,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  };
}
