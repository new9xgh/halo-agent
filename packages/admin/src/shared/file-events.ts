/**
 * Classifier for `file:changed` payloads, shared by every subscriber that only
 * cares about *user* files.
 *
 * The workspace watcher deliberately does NOT exclude `.halo/sessions/` or
 * `.halo/logs/` (see IGNORED_SEGMENTS in server/src/ws/file-watcher.ts — the
 * Explorer needs those events to show sessions coming and going). But a session
 * transcript is rewritten WHOLESALE on every agent utterance — a single file can
 * be >10 MB — so during an active chat these two trees emit a steady stream of
 * events that has nothing to do with anything except the session view. Any
 * subscriber that answers an event with an unconditional refetch (git status /
 * ignored / log) was doing a burst of HTTP round-trips per agent sentence.
 *
 * Filtering happens per subscriber rather than at the watcher or the ws-client,
 * because these events are load-bearing for the ones that DO want them: the file
 * tree (`use-file-tree.ts`, `ws-handlers/file-handlers.ts`) and the session
 * transcript view (`session-chat-panel.tsx`, which matches this very prefix).
 *
 * Trade-off accepted by callers: git decorations for files under these two
 * directories no longer live-update, so an uncommitted session log's badge lags
 * until the next unrelated event / mount / git write. They're machine-written
 * transcripts, not source under review — worth trading for the storm.
 */

/** Workspace-relative (POSIX) prefixes of the agent's own transcript + log churn. */
const SESSION_LOG_PREFIXES = ['.halo/sessions/', '.halo/logs/']

/**
 * True when a `file:changed` event is agent transcript / log churn. Takes the
 * raw handler payload so the shape cast lives here instead of at each call site.
 */
export function isSessionLogEvent(event: { path?: unknown }): boolean {
  const path = event.path
  if (typeof path !== 'string') return false
  return SESSION_LOG_PREFIXES.some((prefix) => path.startsWith(prefix))
}
