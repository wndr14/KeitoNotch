// Crashes and unhandled errors go to a log file (native.logProblem), so "the notch just disappeared" leaves a
// trace: which window, which component, which error. No Keito or Jira data goes in, only the error itself.
import { native } from "./native";

/** The lines a problem becomes: time, window, message, then the stacks. Pure, for tests. */
export function problemLine(view: string, kind: string, error: unknown, componentStack?: string | null, now = new Date()): string {
  const e = error instanceof Error ? error : null;
  const message = e ? `${e.name}: ${e.message}` : String(error);
  const parts = [now.toISOString(), view, kind, message];
  if (e?.stack) parts.push(`stack: ${compact(e.stack)}`);
  if (componentStack) parts.push(`components: ${compact(componentStack)}`);
  return parts.join(" · ");
}

const compact = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 12).join(" < ");

let view = "notch";
let sent = 0;

/** Logs one problem (at most 50 per run, so a crash loop can't fill the disk). Never throws. */
export function reportProblem(kind: string, error: unknown, componentStack?: string | null) {
  if (sent >= 50) return;
  sent++;
  try {
    const line = problemLine(view, kind, error, componentStack);
    console.error(line);
    void native.logProblem(line).catch(() => undefined);
  } catch {
    // Logging must never become the next problem.
  }
}

/** Catches what React and promises don't: uncaught errors and unhandled rejections. */
export function installProblemLog(windowName: string) {
  view = windowName;
  window.addEventListener("error", (e) => reportProblem("error", e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => reportProblem("unhandled promise", e.reason));
}
