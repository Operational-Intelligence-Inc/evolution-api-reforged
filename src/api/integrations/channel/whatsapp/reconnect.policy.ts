/**
 * Baileys DisconnectReason values used here. Kept local (not imported from 'baileys') so this module has no
 * dependencies and its unit tests don't load Baileys.
 */
const DisconnectReason = {
  loggedOut: 401,
  forbidden: 403,
  connectionReplaced: 440,
  restartRequired: 515,
} as const;

/**
 * Reconnect policy for retryable closes (see #10). Delay before attempt N is RECONNECT_DELAYS_MS[N - 1], and the last
 * value repeats. A linked session has no attempt cap (see #51): a retryable close is retried every 5 min until it
 * succeeds, so an outage of any length recovers on its own and the row stays 'connecting' (auto-connected at boot).
 * Logout, delete and a manual connect stop the loop (stopReconnecting), and so do the two cases below that can never
 * succeed on their own (see #56): an unscanned QR pairing past QRCODE_LIMIT, and a 440 loop past
 * RECONNECT_CONFLICT_LIMIT.
 * The attempt counter resets only after the connection has stayed open for STABLE_CONNECTION_MS: in a 440 loop every
 * attempt briefly reaches 'open', so resetting on any open would keep the delays at their shortest.
 */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
export const STABLE_CONNECTION_MS = 60_000;

/** Default for RECONNECT_CONFLICT_LIMIT: consecutive 440 closes before giving up (0 = unlimited). */
export const DEFAULT_RECONNECT_CONFLICT_LIMIT = 10;

/** Closes that are never retried: the session is gone (logged out, banned, ...) and is cleaned up. */
export const CODES_TO_NOT_RECONNECT: readonly number[] = [
  DisconnectReason.loggedOut,
  DisconnectReason.forbidden,
  402,
  406,
];

export function reconnectDelayMs(attempt: number, statusCode?: number): number {
  // 515 (restart required) is the normal restart right after pairing: reconnect at once the first time.
  if (attempt === 1 && statusCode === DisconnectReason.restartRequired) {
    return 0;
  }

  return RECONNECT_DELAYS_MS[Math.min(Math.max(attempt, 1), RECONNECT_DELAYS_MS.length) - 1];
}

/** Consecutive 440 (connectionReplaced) closes, including this one. Any other close code ends the streak. */
export function nextConflictCount(previous: number, statusCode: number | undefined): number {
  return statusCode === DisconnectReason.connectionReplaced ? previous + 1 : 0;
}

export type CloseDecision =
  /** Schedule a reconnect with backoff. */
  | { action: 'retry' }
  /** Stop and clean the session up (logout.instance): non-retryable code, or an unscanned pairing past the limit. */
  | { action: 'stop'; reason: 'not-retryable' | 'qr-limit' }
  /** Stop but keep the session: another client holds these credentials. */
  | { action: 'stop-keep-session'; reason: 'conflict-limit' };

export interface CloseContext {
  statusCode: number | undefined;
  /** The credentials belong to a linked device (Baileys sets creds.account on pair-success). */
  paired: boolean;
  /** QR codes shown in the current pairing, counted across our own retries. */
  qrCount: number;
  /** QRCODE_LIMIT. */
  qrLimit: number;
  /** Consecutive 440 closes including this one (nextConflictCount). */
  conflictCount: number;
  /** RECONNECT_CONFLICT_LIMIT, 0 = unlimited. */
  conflictLimit: number;
}

export function decideOnClose(ctx: CloseContext): CloseDecision {
  if (CODES_TO_NOT_RECONNECT.includes(ctx.statusCode)) {
    return { action: 'stop', reason: 'not-retryable' };
  }

  // A scan ends the pairing socket with 515: it must always reconnect, or a scan near the limit never links.
  if (ctx.statusCode === DisconnectReason.restartRequired) {
    return { action: 'retry' };
  }

  // An unscanned pairing that already showed QRCODE_LIMIT codes. (Hitting the limit on a new QR code is handled in the
  // QR handler: that socket's later events, its close included, are dropped.)
  if (!ctx.paired && ctx.qrLimit > 0 && ctx.qrCount >= ctx.qrLimit) {
    return { action: 'stop', reason: 'qr-limit' };
  }

  if (
    ctx.statusCode === DisconnectReason.connectionReplaced &&
    ctx.conflictLimit > 0 &&
    ctx.conflictCount >= ctx.conflictLimit
  ) {
    return { action: 'stop-keep-session', reason: 'conflict-limit' };
  }

  return { action: 'retry' };
}
