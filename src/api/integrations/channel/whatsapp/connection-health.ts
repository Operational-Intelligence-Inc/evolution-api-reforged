/**
 * Per-instance health for GET /instance/connectionState (see #68): what the socket, the reconnect loop, inbound
 * messages and send acks looked like to this process, plus a verdict.
 *
 * - Memory only. Nothing here reads or writes the database or Redis.
 * - The report carries times and counts only: no JIDs, message ids or text. Message ids are kept in memory to match a
 *   send with its ack, and never leave this module.
 * - The facts start empty when the process starts: read them against `observedSince`.
 *
 * No dependencies beyond reconnect.policy (itself dependency-free), so the unit tests don't load Baileys.
 */

import { DisconnectReason } from './reconnect.policy';

/**
 * Bumped when the shape of the report changes. Servers without this feature answer without `health`.
 * 2: `watchdog` (see #69).
 */
export const HEALTH_VERSION = 2;

/** Window of `reconnects.opens`, `reconnects.drops` and `reconnects.conflicts`. */
export const RECONNECT_WINDOW_MS = 600_000;

/**
 * `looping` thresholds, counted in the window.
 *
 * - Drops, not opens: a restart, and a privacy or profile picture update, each open a new socket on purpose. Only an
 *   open socket that closed on its own is a sign of a loop, and a single one is an ordinary network blip.
 * - In a 440 loop the backoff ends at one attempt per 5 min, so the window never holds more than 2 or 3 conflicts.
 */
export const LOOPING_DROPS = 3;
export const LOOPING_CONFLICTS = 2;

/** `keepalive_silent`: no frame for this many keep-alive intervals. Every answered ping is a frame. */
export const KEEPALIVE_SILENT_INTERVALS = 2;

/** `sends_unacked`: a direct send this old with no ack, and no frame received since it was sent. */
export const UNACKED_STALL_MS = 30_000;

/**
 * A send that was never acked is forgotten after this long. The socket it went out on is gone by then, and the ack
 * will not come: keeping it would report an old loss as a current fault.
 */
export const UNACKED_TTL_MS = 600_000;

/**
 * How far past its deadline the queue's running item must be before the queue reads stuck. The deadline timer fires
 * late on a busy event loop; only a queue that is still held well after it has really stopped.
 */
export const QUEUE_STUCK_MARGIN_MS = 30_000;

/** Most unacked sends tracked at once; the oldest is dropped past it. */
export const MAX_TRACKED_SENDS = 1000;

/** Most ack ids remembered for a send that has not been recorded yet (see `acked`). */
const MAX_EARLY_ACKS = 200;

/** The server's JID as Baileys decodes it from a frame (an empty user part), and its plain form. */
const SERVER_JIDS: readonly unknown[] = ['@s.whatsapp.net', 's.whatsapp.net'];

export type HealthVerdict = 'ok' | 'reconnecting' | 'looping' | 'stalled' | 'closed';

export type HealthReason =
  /** looping: an open socket closed on its own LOOPING_DROPS times or more in the window. */
  | 'reconnect_loop'
  /** looping: LOOPING_CONFLICTS or more 440 closes in the window, another client is using the session. */
  | 'session_conflict'
  /** stalled: the state reads 'open' but the websocket is not open. */
  | 'ws_closed'
  /** stalled: no frame from WhatsApp for KEEPALIVE_SILENT_INTERVALS keep-alive intervals. */
  | 'keepalive_silent'
  /**
   * stalled: the event queue's running item has run past its deadline plus QUEUE_STUCK_MARGIN_MS, so the deadline that
   * should have moved the queue on has failed. A backlog (old items behind slow ones) is not this.
   */
  | 'queue_stuck'
  /** stalled: a direct send is unacked past UNACKED_STALL_MS and nothing was received since. */
  | 'sends_unacked';

/** The state the tracker does not own, read from the instance when a report is built. */
export interface LiveState {
  /** stateConnection.state: 'open', 'connecting' or 'close'. Anything else reads as closed. */
  state: string | undefined;
  /** The websocket itself is open (not stateConnection). */
  wsOpen: boolean;
  /** Current backoff attempt, 0 when stable. */
  attempt: number;
  /** When the scheduled reconnect fires (epoch ms), null when none is scheduled. */
  nextRetryAt: number | null;
  /** How long the event queue's running item has been running, 0 when none is (EventQueueHealth.runningAgeMs). */
  queueRunningAgeMs: number;
  /** EVENT_QUEUE_ITEM_TIMEOUT_MS. */
  queueItemTimeoutMs: number;
}

export interface ConnectionHealthReport {
  version: number;
  /** When this process started tracking the instance. */
  observedSince: string;
  socket: {
    wsOpen: boolean;
    /** Last time a socket reached 'open'. Kept after it closes: `wsOpen` says whether it is still up. */
    openedAt: string | null;
    /** Last frame of any kind received from WhatsApp. */
    lastFrameAt: string | null;
    /** Last answer to a keep-alive ping (see isKeepAliveAnswer). */
    lastKeepAliveAt: string | null;
  };
  reconnects: {
    windowMs: number;
    /** Times a socket reached 'open' in the window, restarts asked for through the API included. */
    opens: number;
    /** Times an open socket closed on its own in the window. A socket replaced on purpose is not a drop. */
    drops: number;
    /** 440 (connection replaced) closes in the window. */
    conflicts: number;
    attempt: number;
    nextRetryAt: string | null;
    lastCloseCode: number | null;
    lastCloseAt: string | null;
  };
  /** When the last message from someone else arrived (arrival time, not the message's own timestamp). */
  inbound: { lastMessageAt: string | null };
  outbound: {
    /** Last time WhatsApp acked a send of ours, to a person or a group. */
    lastAckAt: string | null;
    /** Sends to a person in the last UNACKED_TTL_MS that have no ack yet. */
    unacked: number;
    oldestUnackedAt: string | null;
  };
  verdict: HealthVerdict;
  reasons: HealthReason[];
}

export interface ConnectionHealthOptions {
  /** The socket's keep-alive interval (Baileys keepAliveIntervalMs). */
  keepAliveIntervalMs: number;
  now?: () => number;
}

/**
 * A send to a person, not to a group, a broadcast list or a channel. Only these count as unacked: a group send often
 * gets no receipt on a healthy account.
 */
export function isPersonJid(jid: unknown): boolean {
  return typeof jid === 'string' && /@(s\.whatsapp\.net|lid|c\.us)$/.test(jid);
}

/**
 * True for the server's answer to a keep-alive ping: an `iq` result from the server that carries the server time
 * (`t`) and no content, as seen on a live socket:
 * `<iq from="@s.whatsapp.net" type="result" id="…" t="1795312056"/>`.
 *
 * Baileys sends the ping from a closure and reports nothing when it is answered, so the answer is recognised by its
 * shape. Another request answered with the same shape would match too. It is still the server answering a request on
 * this socket, and the verdict does not depend on it: `keepalive_silent` is decided on `lastFrameAt`.
 */
export function isKeepAliveAnswer(frame: unknown): boolean {
  const node = frame as { tag?: unknown; attrs?: Record<string, unknown>; content?: unknown } | null;

  if (!node || node.tag !== 'iq' || node.attrs?.type !== 'result' || !node.attrs.t) {
    return false;
  }

  if (!SERVER_JIDS.includes(node.attrs.from)) {
    return false;
  }

  return node.content == null || (Array.isArray(node.content) && node.content.length === 0);
}

/** Epoch ms as an ISO string, null when unset. */
export const iso = (time: number | null | undefined): string | null =>
  time == null ? null : new Date(time).toISOString();

export class ConnectionHealth {
  private readonly now: () => number;
  private readonly keepAliveIntervalMs: number;
  private readonly observedSince: number;

  private openedAt: number | null = null;
  private lastFrameAt: number | null = null;
  private lastKeepAliveAt: number | null = null;
  private lastCloseCode: number | null = null;
  private lastCloseAt: number | null = null;
  private lastMessageAt: number | null = null;
  private lastAckAt: number | null = null;

  /** Times of the opens, the drops and the 440 closes in the window, oldest first. */
  private opens: number[] = [];
  private drops: number[] = [];
  private conflicts: number[] = [];
  /** The current socket reached 'open' and has not closed. */
  private open = false;

  /** Message id -> send time of the direct sends with no ack yet. Insertion order is send order. */
  private readonly unacked = new Map<string, number>();
  /** Ids acked before their send was recorded. */
  private readonly earlyAcks = new Set<string>();

  constructor(options: ConnectionHealthOptions) {
    this.now = options.now ?? Date.now;
    this.keepAliveIntervalMs = options.keepAliveIntervalMs;
    this.observedSince = this.now();
  }

  /** A new socket replaced the current one, on purpose or as a retry. The old one's end is not a drop. */
  public socketCreated(): void {
    this.open = false;
  }

  /** The connection reached 'open'. */
  public socketOpened(): void {
    const now = this.now();
    this.open = true;
    this.openedAt = now;
    this.opens.push(now);
    this.opens = this.inWindow(this.opens, now);
  }

  /** The current socket closed on its own with this code (a socket torn down on purpose reports no close). */
  public socketClosed(statusCode: number | undefined): void {
    const now = this.now();
    this.lastCloseAt = now;
    this.lastCloseCode = statusCode ?? null;

    if (this.open) {
      this.open = false;
      this.drops.push(now);
      this.drops = this.inWindow(this.drops, now);
    }

    if (statusCode === DisconnectReason.connectionReplaced) {
      this.conflicts.push(now);
      this.conflicts = this.inWindow(this.conflicts, now);
    }
  }

  /** Any frame arrived from WhatsApp. */
  public frameReceived(frame?: unknown): void {
    const now = this.now();
    this.lastFrameAt = now;

    if (isKeepAliveAnswer(frame)) {
      this.lastKeepAliveAt = now;
    }
  }

  /** A message from someone else arrived. */
  public messageReceived(): void {
    this.lastMessageAt = this.now();
  }

  /** A send was written to the socket. */
  public sent(jid: unknown, messageId: unknown): void {
    if (typeof messageId !== 'string' || !messageId || !isPersonJid(jid)) {
      return;
    }

    // The ack can be handled before the send call returns its id.
    if (this.earlyAcks.delete(messageId) || this.unacked.has(messageId)) {
      return;
    }

    this.unacked.set(messageId, this.now());

    while (this.unacked.size > MAX_TRACKED_SENDS) {
      this.unacked.delete(this.unacked.keys().next().value);
    }
  }

  /** WhatsApp acked a send (the `ack` stanza, with or without an error code: either way the server answered). */
  public acked(messageId: unknown): void {
    this.lastAckAt = this.now();

    if (typeof messageId !== 'string' || !messageId || this.unacked.delete(messageId)) {
      return;
    }

    this.earlyAcks.add(messageId);

    while (this.earlyAcks.size > MAX_EARLY_ACKS) {
      this.earlyAcks.delete(this.earlyAcks.values().next().value);
    }
  }

  /**
   * A receipt (sent, delivered, read) arrived for a send. It is no longer unacked, even when its ack was lost with the
   * socket it went out on. `lastAckAt` is left alone: a receipt can come days after the send.
   */
  public receipted(messageId: unknown): void {
    if (typeof messageId === 'string') {
      this.unacked.delete(messageId);
    }
  }

  /**
   * The `stalled` reasons that hold now, read whatever the verdict is: a looping instance that reads 'open' can be
   * stalled too, and the verdict would only say `looping`. The caller decides whether the state makes them count.
   * Used by the watchdog (see #69).
   */
  public stallReasons(live: LiveState): HealthReason[] {
    const now = this.now();
    const oldestUnackedAt = this.oldestUnackedAt(now);

    return this.stalled(live, now, oldestUnackedAt);
  }

  public report(live: LiveState): ConnectionHealthReport {
    const now = this.now();

    this.opens = this.inWindow(this.opens, now);
    this.drops = this.inWindow(this.drops, now);
    this.conflicts = this.inWindow(this.conflicts, now);

    const oldestUnackedAt = this.oldestUnackedAt(now);
    const { verdict, reasons } = this.verdict(live, now, oldestUnackedAt);

    return {
      version: HEALTH_VERSION,
      observedSince: iso(this.observedSince),
      socket: {
        wsOpen: live.wsOpen,
        openedAt: iso(this.openedAt),
        lastFrameAt: iso(this.lastFrameAt),
        lastKeepAliveAt: iso(this.lastKeepAliveAt),
      },
      reconnects: {
        windowMs: RECONNECT_WINDOW_MS,
        opens: this.opens.length,
        drops: this.drops.length,
        conflicts: this.conflicts.length,
        attempt: live.attempt,
        nextRetryAt: iso(live.nextRetryAt),
        lastCloseCode: this.lastCloseCode,
        lastCloseAt: iso(this.lastCloseAt),
      },
      inbound: { lastMessageAt: iso(this.lastMessageAt) },
      outbound: {
        lastAckAt: iso(this.lastAckAt),
        unacked: this.unacked.size,
        oldestUnackedAt: iso(oldestUnackedAt),
      },
      verdict,
      reasons,
    };
  }

  /**
   * First match: closed, looping, reconnecting, stalled, ok.
   *
   * `looping` is checked before `reconnecting`: an instance in a reconnect loop spends nearly all of its time in
   * 'connecting', waiting for the next attempt, and would otherwise almost never read as looping.
   */
  private verdict(
    live: LiveState,
    now: number,
    oldestUnackedAt: number | null,
  ): { verdict: HealthVerdict; reasons: HealthReason[] } {
    if (live.state !== 'open' && live.state !== 'connecting') {
      return { verdict: 'closed', reasons: [] };
    }

    const looping: HealthReason[] = [];
    if (this.drops.length >= LOOPING_DROPS) looping.push('reconnect_loop');
    if (this.conflicts.length >= LOOPING_CONFLICTS) looping.push('session_conflict');

    if (looping.length) {
      return { verdict: 'looping', reasons: looping };
    }

    // Waiting for a scheduled retry, or a socket that is still connecting or pairing.
    if (live.state === 'connecting') {
      return { verdict: 'reconnecting', reasons: [] };
    }

    const stalled = this.stalled(live, now, oldestUnackedAt);

    return stalled.length ? { verdict: 'stalled', reasons: stalled } : { verdict: 'ok', reasons: [] };
  }

  /** The `stalled` reasons that hold now, whatever the state and the verdict. */
  private stalled(live: LiveState, now: number, oldestUnackedAt: number | null): HealthReason[] {
    const stalled: HealthReason[] = [];

    if (!live.wsOpen) stalled.push('ws_closed');

    // A new socket has received nothing yet: its silence is counted from when it opened.
    const lastHeardAt = Math.max(this.lastFrameAt ?? 0, this.openedAt ?? 0);
    if (lastHeardAt > 0 && now - lastHeardAt > KEEPALIVE_SILENT_INTERVALS * this.keepAliveIntervalMs) {
      stalled.push('keepalive_silent');
    }

    if (live.queueItemTimeoutMs > 0 && live.queueRunningAgeMs > live.queueItemTimeoutMs + QUEUE_STUCK_MARGIN_MS) {
      stalled.push('queue_stuck');
    }

    if (
      oldestUnackedAt !== null &&
      now - oldestUnackedAt > UNACKED_STALL_MS &&
      (this.lastFrameAt === null || this.lastFrameAt <= oldestUnackedAt)
    ) {
      stalled.push('sends_unacked');
    }

    return stalled;
  }

  private inWindow(times: number[], now: number): number[] {
    const from = now - RECONNECT_WINDOW_MS;
    return times[0] > from ? times : times.filter((time) => time > from);
  }

  /** When the oldest send still unacked went out, after dropping expired ones; null when none is. */
  private oldestUnackedAt(now: number): number | null {
    this.dropExpiredSends(now);
    return this.unacked.size ? this.unacked.values().next().value : null;
  }

  private dropExpiredSends(now: number): void {
    for (const [messageId, sentAt] of this.unacked) {
      if (now - sentAt <= UNACKED_TTL_MS) {
        break;
      }
      this.unacked.delete(messageId);
    }
  }
}
