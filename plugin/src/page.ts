import type { Reference } from "./reference.ts";

/** The session a page path names. Used only on LearnHarness versions that cannot
 * tell a plugin which session is in front (no `ctx.app.currentSession`). */
export function sessionIdFromPath(pathname: string): string | undefined {
  const match = /^\/chat\/([^/]+)\/?$/.exec(pathname);
  if (!match) return undefined;
  let id: string;
  try { id = decodeURIComponent(match[1]!); } catch { return undefined; }
  return id !== "new" && /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined;
}
export function parseKindResponse(value: unknown, sessionId: string): "teaching" | "practice" | undefined {
  const input = value as { sessionId?: unknown; kind?: unknown } | null;
  if (!input || typeof input !== "object" || input.sessionId !== sessionId) throw new Error("Remote Draw returned an unreadable session kind.");
  return input.kind === "teaching" || input.kind === "practice" ? input.kind : undefined;
}
/** Whether a sheet made for one question still shows the current one. */
export function sameReference(a: Reference | undefined, b: Reference | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
