import Long from 'long';
import { RedisClientType } from 'redis';

/**
 * Durable per-instance queue for Baileys socket events (see #50).
 *
 * Baileys sends the delivery receipt before it emits `messages.upsert`, so once an event reaches us WhatsApp will not
 * resend it. Events used to live only in an in-memory promise chain: a restart lost the backlog, and one hung await
 * stalled the instance with nothing logged.
 *
 * - Data events are written to a Redis stream (XADD) when they arrive, before processing, and deleted (XDEL) once
 *   processed. All XADDs go over the one shared Redis connection, in arrival order.
 * - On the instance's first socket, `replay()` processes whatever is still in the stream before any live event.
 * - Each item runs under a deadline: past it, the event types and the running handler are logged and the queue moves
 *   on. The hung work is left to settle on its own, and its entry is acked when it does.
 * - Without Redis (disabled, not ready, or a failed write) events are processed in memory as before.
 */

/** Events persisted to the stream. Socket-lifecycle events (connection.update, creds.update, call, presence.update)
 * describe the live socket and mean nothing after a restart, so they are never persisted. */
export const PERSISTED_EVENTS = [
  'messaging-history.set',
  'messages.upsert',
  'messages.update',
  'message-receipt.update',
  'chats.upsert',
  'chats.update',
  'chats.delete',
  'contacts.upsert',
  'contacts.update',
  'groups.upsert',
  'groups.update',
  'group-participants.update',
  'labels.association',
  'labels.edit',
] as const;

const PERSISTED_EVENT_SET = new Set<string>(PERSISTED_EVENTS);

export type EventMap = Record<string, any>;

/** Tracks which handler an item is running, so a timeout can name it. */
export type QueueItemContext = { step?: string };

export type EventQueueHealth = {
  /** Items received but not yet processed (including the one running). */
  pending: number;
  /** Age of the oldest pending item, 0 when the queue is empty. A backlog: says nothing about whether it moves. */
  oldestAgeMs: number;
  /**
   * How long the item now running has been running, 0 when none is. The item deadline bounds it, so past the deadline
   * the deadline itself has failed and the queue has stopped.
   */
  runningAgeMs: number;
  /** Items that have left the queue since it was created. Unchanged between two reads: the queue did not move. */
  processed: number;
  /** Whether new events are currently being persisted to Redis. */
  persistent: boolean;
};

export type QueueLogger = {
  info(value: any): void;
  warn(value: any): void;
  error(value: any): void;
};

export type BaileysEventQueueOptions = {
  instanceId: string;
  logger: QueueLogger;
  /** Shared Redis connection, or null to keep the queue in memory only. */
  redis: RedisClientType | null;
  prefix: string;
  itemTimeoutMs: number;
  maxEntryBytes: number;
  maxLength: number;
  /** How long replay waits for the stream read before giving up on it. */
  replayReadTimeoutMs?: number;
};

const WARN_INTERVAL_MS = 60_000;
const LONG_MARKER = '__evqLong';
const DATE_MARKER = '__evqDate';

/**
 * Converts an event payload to plain JSON-safe data.
 *
 * Done by hand rather than with JSON.stringify's replacer: protobuf messages (WAProto) define toJSON, which turns
 * bytes into base64 strings, enums into their names and Longs into strings, so a revived media message would have no
 * usable mediaKey. Only own enumerable fields are kept; protobuf defaults live on the prototype and read the same
 * (null or undefined) when absent.
 */
function encodeValue(value: any): any {
  if (value === null || value === undefined) return value;

  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return value.toString();
  if (type === 'function' || type === 'symbol') return undefined;

  if (Long.isLong(value)) {
    return { [LONG_MARKER]: true, low: value.low, high: value.high, unsigned: value.unsigned };
  }

  if (value instanceof Uint8Array) {
    return { type: 'Buffer', data: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  }

  if (value instanceof Date) {
    return { [DATE_MARKER]: value.toISOString() };
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      const encoded = encodeValue(item);
      return encoded === undefined ? null : encoded;
    });
  }

  const out: Record<string, any> = {};
  for (const key of Object.keys(value)) {
    const encoded = encodeValue(value[key]);
    if (encoded !== undefined) out[key] = encoded;
  }

  return out;
}

function reviveValue(_key: string, value: any): any {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;

  if (value[LONG_MARKER] === true) {
    return Long.fromBits(value.low, value.high, value.unsigned);
  }

  if (value.type === 'Buffer' && typeof value.data === 'string' && Object.keys(value).length === 2) {
    return Buffer.from(value.data, 'base64');
  }

  if (typeof value[DATE_MARKER] === 'string' && Object.keys(value).length === 1) {
    return new Date(value[DATE_MARKER]);
  }

  return value;
}

export function serializeEvents(events: EventMap): string {
  return JSON.stringify(encodeValue(events));
}

export function deserializeEvents(json: string): EventMap {
  return JSON.parse(json, reviveValue);
}

/** The subset of `events` that is persisted, or null when there is none. */
export function pickPersistedEvents(events: EventMap): EventMap | null {
  let picked: EventMap | null = null;

  for (const key of Object.keys(events)) {
    if (PERSISTED_EVENT_SET.has(key) && events[key] !== undefined) {
      picked ??= {};
      picked[key] = events[key];
    }
  }

  return picked;
}

/** Stream IDs are `<ms>-<seq>`. */
function streamIdTime(id: string): number {
  const ms = Number.parseInt(id, 10);
  return Number.isFinite(ms) ? ms : Date.now();
}

export class BaileysEventQueue {
  private chain: Promise<void> = Promise.resolve();
  /** Arrival time of every pending item, in queue order: the head is the item running (or next to run). */
  private readonly pendingSince: number[] = [];
  /** Items that left the queue (see EventQueueHealth.processed). */
  private processed = 0;
  /** When the item now running started (see EventQueueHealth.runningAgeMs), null when none is. */
  private runningSince: number | null = null;
  private readonly key: string;
  private lastWarnAt = 0;
  private replayed = false;

  constructor(private readonly options: BaileysEventQueueOptions) {
    this.key = `${options.prefix}:evq:${options.instanceId}`;
  }

  public get streamKey() {
    return this.key;
  }

  private get redisReady(): boolean {
    return !!this.options.redis?.isReady;
  }

  /** Rate-limited, so a Redis outage logs once a minute instead of once per event. */
  private warnRateLimited(message: string) {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    this.options.logger.warn(message);
  }

  /**
   * Writes the persistable part of `events` to the stream. Must be called synchronously from the socket's event
   * callback: the XADD is issued before this returns, which is what keeps stream order equal to arrival order.
   * Resolves to the entry id, or null when nothing was persisted. Never rejects.
   */
  public persist(events: EventMap): Promise<string | null> {
    const picked = pickPersistedEvents(events);
    if (!picked || !this.options.redis) return Promise.resolve(null);

    const types = Object.keys(picked);

    if (!this.redisReady) {
      this.warnRateLimited(`Event queue: Redis not ready, processing events in memory only (${types.join(', ')})`);
      return Promise.resolve(null);
    }

    let json: string;
    try {
      json = serializeEvents(picked);
    } catch (error) {
      this.options.logger.warn(`Event queue: could not serialise ${types.join(', ')}: ${error?.message ?? error}`);
      return Promise.resolve(null);
    }

    const bytes = Buffer.byteLength(json);
    if (bytes > this.options.maxEntryBytes) {
      this.options.logger.warn(
        `Event queue: ${types.join(', ')} is ${bytes} bytes, over EVENT_QUEUE_MAX_ENTRY_BYTES ` +
          `(${this.options.maxEntryBytes}); processing it without persisting`,
      );
      return Promise.resolve(null);
    }

    return this.options.redis
      .xAdd(
        this.key,
        '*',
        { e: json },
        { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: this.options.maxLength } },
      )
      .catch((error) => {
        this.warnRateLimited(`Event queue: XADD failed, processing events in memory only: ${error?.message ?? error}`);
        return null;
      });
  }

  /**
   * Queues `run` behind every earlier item. `entryId` is the stream entry to delete once `run` settles.
   */
  public enqueue(
    types: string[],
    run: (ctx: QueueItemContext) => Promise<void>,
    entryId: Promise<string | null> | string | null = null,
  ) {
    this.pendingSince.push(Date.now());

    this.chain = this.chain
      .then(() => this.runItem(types, run, entryId))
      .finally(() => {
        this.settle();
      });
  }

  /**
   * Processes the entries left in the stream by a previous process, ahead of every live event. Must be called before
   * the socket's events are attached: the XRANGE is issued here, synchronously, so no live XADD can land in its result.
   * Runs at most once per queue.
   */
  public replay(handler: (events: EventMap, ctx: QueueItemContext) => Promise<void>) {
    if (this.replayed) return;
    this.replayed = true;

    if (!this.options.redis) return;

    // Only a closed client is skipped. One still connecting (e.g. at boot) holds the XRANGE in its offline queue and
    // sends it first once ready; persist() writes nothing until then, so the read still precedes every live XADD.
    // The read timeout below bounds how long live events wait behind it.
    if (!this.options.redis.isOpen) {
      this.options.logger.warn('Event queue: Redis not connected, skipping replay of persisted events');
      return;
    }

    const read = this.options.redis.xRange(this.key, '-', '+');
    const timeoutMs = this.options.replayReadTimeoutMs ?? 30_000;

    this.pendingSince.push(Date.now());

    this.chain = this.chain.then(async () => {
      let entries: { id: string; message: Record<string, string> }[] | null;
      let timer: NodeJS.Timeout;

      // The read holds the queue like an item does, under its own deadline.
      this.runningSince = Date.now();

      try {
        entries = await Promise.race([
          read,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
          }),
        ]);
      } catch (error) {
        this.options.logger.warn(`Event queue: replay read failed: ${error?.message ?? error}`);
        entries = null;
      } finally {
        clearTimeout(timer);
        this.runningSince = null;
      }

      if (!entries) {
        this.settle();
        this.options.logger.warn('Event queue: replay read did not complete, persisted events not replayed');
        // Swallow a late rejection of the abandoned read.
        read.catch(() => undefined);
        return;
      }

      // Swap the placeholder for one slot per entry, aged by the time it was first received.
      this.pendingSince.splice(0, 1, ...entries.map((entry) => streamIdTime(entry.id)));

      if (entries.length > 0) {
        this.options.logger.info(`Event queue: replaying ${entries.length} persisted event batch(es)`);
      }

      for (const entry of entries) {
        try {
          let events: EventMap;
          try {
            events = deserializeEvents(entry.message?.e);
          } catch (error) {
            this.options.logger.error(`Event queue: dropping unreadable entry ${entry.id}: ${error?.message ?? error}`);
            this.ack(entry.id);
            continue;
          }

          await this.runItem(Object.keys(events), (ctx) => handler(events, ctx), entry.id);
        } finally {
          this.settle();
        }
      }
    });
  }

  private async runItem(
    types: string[],
    run: (ctx: QueueItemContext) => Promise<void>,
    entryId: Promise<string | null> | string | null,
  ) {
    const ctx: QueueItemContext = {};
    const startedAt = Date.now();
    this.runningSince = startedAt;
    const work = Promise.resolve().then(() => run(ctx));

    // Ack once the work settles, even if that happens after the deadline below.
    work.catch(() => undefined).then(() => this.ack(entryId));

    let timer: NodeJS.Timeout;
    let outcome: 'done' | 'timeout';
    try {
      outcome = await Promise.race([
        work.then(
          () => 'done' as const,
          (error) => {
            this.options.logger.error(error);
            return 'done' as const;
          },
        ),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), this.options.itemTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.runningSince = null;
    }

    if (outcome === 'timeout') {
      const step = ctx.step ?? 'unknown';
      this.options.logger.error(
        `Event queue: item exceeded ${this.options.itemTimeoutMs}ms (events: ${types.join(', ') || 'none'}, ` +
          `handler: ${step}); moving on to the next item`,
      );

      work.then(
        () =>
          this.options.logger.warn(
            `Event queue: timed-out item (handler: ${ctx.step ?? step}) settled after ${Date.now() - startedAt}ms`,
          ),
        () => undefined,
      );
    }
  }

  private ack(entryId: Promise<string | null> | string | null) {
    const redis = this.options.redis;
    if (!redis || entryId === null) return;

    Promise.resolve(entryId)
      .then((id) => {
        if (id && redis.isOpen) return redis.xDel(this.key, id);
      })
      .catch((error) => this.warnRateLimited(`Event queue: XDEL failed: ${error?.message ?? error}`));
  }

  /** The head item left the queue, processed or given up on. */
  private settle() {
    this.pendingSince.shift();
    this.processed++;
  }

  public health(): EventQueueHealth {
    // The head is the oldest: live items arrive in order, and replayed entries (older still) sit in front of them.
    const oldest = this.pendingSince[0];

    return {
      pending: this.pendingSince.length,
      oldestAgeMs: oldest === undefined ? 0 : Math.max(0, Date.now() - oldest),
      runningAgeMs: this.runningSince === null ? 0 : Math.max(0, Date.now() - this.runningSince),
      processed: this.processed,
      persistent: this.redisReady,
    };
  }

  /** Deletes every persisted entry (logout, instance delete). */
  public async clear() {
    const redis = this.options.redis;
    if (!redis?.isOpen) return;

    try {
      await redis.del(this.key);
    } catch (error) {
      this.options.logger.warn(`Event queue: could not clear ${this.key}: ${error?.message ?? error}`);
    }
  }
}
