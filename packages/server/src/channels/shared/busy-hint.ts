/**
 * Shared "session is busy" hint for the IM channels.
 *
 * Every channel needs the same thing before handing a message to
 * `sendUserMessage`: if the session is compacting or mid-turn, tell the user
 * their message landed but won't be answered instantly. The four channels had
 * this inlined, and the copy-paste is exactly how a bug spread to all of them:
 * the compacting branch carried an extra `return`, so a message sent during a
 * compact was answered with a hint and then DROPPED — never queued, never run.
 * (`sendUserMessage` queues compacting/busy sessions itself; the channel's only
 * job is the hint.)
 *
 * This helper deliberately returns the text instead of sending it: the four
 * channels' send paths are wildly different (`ctx.reply` / `postMessage` /
 * `replyToInbound` / `sendToUser`, each with their own thread/token plumbing),
 * and threading those in as callbacks would cost more than it saves. Caller
 * sends, then falls through to its normal enqueue path unconditionally.
 */
import type { SessionManager } from '../../agents/session-manager.js'
import { t, type Lang } from './i18n.js'

/**
 * Hint text for a session about to receive a message, or null when the session
 * is idle (nothing to say). Never a reason to skip delivering the message.
 */
export function busyHint(sm: SessionManager, sessionId: string, lang: Lang): string | null {
  if (sm.isSessionCompacting(sessionId)) return t('handler.compacting', lang)
  if (sm.isSessionRunning(sessionId)) return t('handler.queued', lang)
  return null
}
