// lib/logger.js — Shared timestamp logger (single source of truth).
// Extracted from agent.js to break the circular dependency:
// every module previously imported { ts } from ./agent.js, which pulled
// firebase-admin into ANY importer's module graph (breaking tests and
// worktrees without node_modules). Import this module instead.
export function ts() {
  const now = new Date();
  return `[${now.toTimeString().slice(0, 8)}]`;
}
