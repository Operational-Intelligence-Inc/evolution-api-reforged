/**
 * Per-instance watchdog (see #69): when an instance reads 'open' but its socket does not work, rebuild that one
 * instance's socket instead of restarting the whole service.
 *
 * - Acts on the facts of the health tracker (#68): the websocket is not open, or nothing was heard for two keep-alive
 *   intervals. Unacked sends are never a trigger: a missing ack has too many innocent causes (#67), it is only
 *   reported. Nor is a stuck event queue (#73): the queue belongs to the instance, not the socket, so a rebuild leaves
 *   it as it was, and a slow queue would otherwise rebuild a working socket. It is only reported.
 * - Only while the state reads 'open' and nothing else owns the socket (a pairing, a scheduled reconnect, a socket
 *   being created), and only once a trigger has held for WATCHDOG_CONFIRM_MS, so one slow moment is not a rebuild.
 * - Rebuilds back off on the schedule of retried closes, and stop after `maxRebuilds` consecutive rebuilds that did
 *   not produce a healthy socket (`gaveUp`).
 * - This module decides; the service rebuilds. No dependencies besides reconnect.policy, so the unit tests don't load
 *   Baileys.
 */

import { reconnectDelayMs, STABLE_CONNECTION_MS } from './reconnect.policy';

/** off: do nothing. report: log what would be rebuilt, change nothing. on: rebuild. */
export type WatchdogMode = 'off' | 'report' | 'on';

export const WATCHDOG_MODES: readonly WatchdogMode[] = ['off', 'report', 'on'];
export const DEFAULT_WATCHDOG_MODE: WatchdogMode = 'report';

/** Default for WATCHDOG_MAX_REBUILDS: consecutive rebuilds without a healthy socket before giving up. */
export const DEFAULT_WATCHDOG_MAX_REBUILDS = 5;

/** How often the service runs a check. */
export const WATCHDOG_CHECK_INTERVAL_MS = 10_000;

/** A trigger must hold this long, through every check, before it counts. */
export const WATCHDOG_CONFIRM_MS = 30_000;

/** Open with no trigger for this long: the socket is healthy, and the rebuild count and `gaveUp` reset. */
export const WATCHDOG_HEALTHY_MS = STABLE_CONNECTION_MS;

/** The health reasons that trigger a rebuild, in the order a reason is picked when several hold. */
export const WATCHDOG_TRIGGERS = ['ws_closed', 'keepalive_silent'] as const;

export type WatchdogTrigger = (typeof WATCHDOG_TRIGGERS)[number];

export interface WatchdogInput {
  /** stateConnection.state. Only 'open' is watched. */
  state: string | undefined;
  /** Something else owns the socket: a pairing, a scheduled reconnect, or a socket being created. */
  busy: boolean;
  /** The health tracker's stalled reasons (ConnectionHealth.stallReasons). Those that are not triggers are ignored. */
  reasons: readonly string[];
}

export type WatchdogDecision =
  | { action: 'none' }
  /** mode 'on': rebuild the socket now, then call rebuildFinished(). `attempt` counts since the last healthy socket. */
  | { action: 'rebuild'; reason: WatchdogTrigger; attempt: number }
  /** mode 'report': a rebuild would happen now. Returned once per episode. */
  | { action: 'report'; reason: WatchdogTrigger }
  /** The cap was reached: no more rebuilds until the socket is healthy again or reset() is called. Returned once. */
  | { action: 'give-up'; reason: WatchdogTrigger; rebuilds: number };

export interface WatchdogReport {
  mode: WatchdogMode;
  /** Rebuilds since the process started. */
  rebuilds: number;
  lastRebuildAt: string | null;
  /** Trigger of the last rebuild, or in report mode of the last would-be rebuild. */
  lastReason: WatchdogTrigger | null;
  /** Report mode: rebuilds that would have happened. */
  wouldRebuild: number;
  gaveUp: boolean;
}

export interface ConnectionWatchdogOptions {
  mode: WatchdogMode;
  maxRebuilds: number;
  now?: () => number;
}

/** WATCHDOG_MODE: off, report or on (any case). Anything else is the default. */
export function parseWatchdogMode(value: string | undefined): WatchdogMode {
  const mode = value?.trim().toLowerCase() as WatchdogMode;
  return WATCHDOG_MODES.includes(mode) ? mode : DEFAULT_WATCHDOG_MODE;
}

/** WATCHDOG_MAX_REBUILDS: a positive integer. There is no unlimited value: an uncapped watchdog is its own loop. */
export function parseWatchdogMaxRebuilds(value: string | undefined): number {
  const max = Number.parseInt(value ?? '', 10);
  return Number.isFinite(max) && max >= 1 ? max : DEFAULT_WATCHDOG_MAX_REBUILDS;
}

const iso = (time: number | null): string | null => (time == null ? null : new Date(time).toISOString());

export class ConnectionWatchdog {
  public readonly mode: WatchdogMode;
  private readonly maxRebuilds: number;
  private readonly now: () => number;

  /** Trigger -> when it began holding, without a break. */
  private readonly since = new Map<WatchdogTrigger, number>();
  /** Open with no trigger since, or null. */
  private healthySince: number | null = null;

  /** Rebuilds since the last healthy socket. */
  private consecutive = 0;
  private rebuilds = 0;
  private wouldRebuild = 0;
  private lastRebuildAt: number | null = null;
  private lastReason: WatchdogTrigger | null = null;
  private gaveUp = false;
  /** A confirmed episode was already reported (report mode). Cleared when every trigger has cleared. */
  private reported = false;
  private inFlight = false;

  constructor(options: ConnectionWatchdogOptions) {
    this.mode = options.mode;
    this.maxRebuilds = options.maxRebuilds;
    this.now = options.now ?? Date.now;
  }

  public check(input: WatchdogInput): WatchdogDecision {
    if (this.mode === 'off') {
      return { action: 'none' };
    }

    const now = this.now();

    // Not watched now: a trigger must hold through a whole confirmation period of watched checks.
    if (this.inFlight || input.busy || input.state !== 'open') {
      this.since.clear();
      this.healthySince = null;
      return { action: 'none' };
    }

    const active = WATCHDOG_TRIGGERS.filter((trigger) => input.reasons.includes(trigger));
    this.track(active, now);

    if (this.since.size === 0) {
      this.reported = false;
      this.healthySince ??= now;

      if (now - this.healthySince >= WATCHDOG_HEALTHY_MS) {
        this.consecutive = 0;
        this.gaveUp = false;
      }

      return { action: 'none' };
    }

    this.healthySince = null;

    const reason = WATCHDOG_TRIGGERS.find(
      (trigger) => this.since.has(trigger) && now - this.since.get(trigger) >= WATCHDOG_CONFIRM_MS,
    );

    if (!reason || this.gaveUp) {
      return { action: 'none' };
    }

    if (this.mode === 'report') {
      if (this.reported) {
        return { action: 'none' };
      }

      this.reported = true;
      this.wouldRebuild++;
      this.lastReason = reason;
      return { action: 'report', reason };
    }

    if (this.consecutive >= this.maxRebuilds) {
      this.gaveUp = true;
      return { action: 'give-up', reason, rebuilds: this.consecutive };
    }

    if (
      this.lastRebuildAt !== null &&
      this.consecutive > 0 &&
      now - this.lastRebuildAt < reconnectDelayMs(this.consecutive)
    ) {
      return { action: 'none' };
    }

    this.consecutive++;
    this.rebuilds++;
    this.lastRebuildAt = now;
    this.lastReason = reason;
    this.inFlight = true;
    this.since.clear();

    return { action: 'rebuild', reason, attempt: this.consecutive };
  }

  /** The rebuild returned by check() is over, whether or not it produced a socket. */
  public rebuildFinished(): void {
    this.inFlight = false;
  }

  /** A connect or restart asked for through the API: a fresh rebuild budget, and a watchdog that gave up resumes. */
  public reset(): void {
    this.since.clear();
    this.healthySince = null;
    this.consecutive = 0;
    this.gaveUp = false;
    this.reported = false;
  }

  public report(): WatchdogReport {
    return {
      mode: this.mode,
      rebuilds: this.rebuilds,
      lastRebuildAt: iso(this.lastRebuildAt),
      lastReason: this.lastReason,
      wouldRebuild: this.wouldRebuild,
      gaveUp: this.gaveUp,
    };
  }

  private track(active: WatchdogTrigger[], now: number) {
    for (const trigger of [...this.since.keys()]) {
      if (!active.includes(trigger)) this.since.delete(trigger);
    }

    for (const trigger of active) {
      if (!this.since.has(trigger)) this.since.set(trigger, now);
    }
  }
}
