/**
 * Holds `messages.update` events of sent messages whose row is not stored yet (see #67).
 *
 * An API send stores its row only after the relay and the Chatwoot/OpenAI steps, while the server ack arrives through
 * the event queue, so the ack can be handled first. It used to be skipped, and the message then had no ack recorded
 * until the next receipt, which for an offline recipient can be a day later.
 *
 * - `hold()` keeps an update under its message id. `release()` hands the held updates back once that message is stored.
 * - `release()` also remembers the id as stored. The handler's lookup can miss a row that is stored while the lookup
 *   runs; `hold()` then returns false and the handler looks again, instead of holding an update nobody will release.
 * - Entries expire after `ttlMs`, and the oldest are dropped past `maxMessages`. Expiry is checked on access, so there
 *   is no timer to stop.
 */

export type PendingMessageUpdatesOptions = {
  /** How long an update waits for its message, and how long a stored id is remembered. */
  ttlMs?: number;
  /** Most message ids tracked at once (held and stored together). */
  maxMessages?: number;
  /** Most updates held for one message; the oldest is dropped past it. */
  maxPerMessage?: number;
  now?: () => number;
};

type Entry<T> = { expiresAt: number; stored: boolean; updates: T[] };

export class PendingMessageUpdates<T> {
  // Insertion order is expiry order: an entry gets its expiry when it is inserted and never a later one.
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxMessages: number;
  private readonly maxPerMessage: number;
  private readonly now: () => number;

  constructor(options: PendingMessageUpdatesOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxMessages = options.maxMessages ?? 1000;
    this.maxPerMessage = options.maxPerMessage ?? 20;
    this.now = options.now ?? Date.now;
  }

  /** Message ids tracked right now, held and stored together. */
  public get size(): number {
    this.dropExpired();
    return this.entries.size;
  }

  /**
   * Keeps an update until its message is stored.
   * @returns false when the message was stored a moment ago: the update is not kept, look the message up again.
   */
  public hold(messageId: string, update: T): boolean {
    this.dropExpired();

    const entry = this.entries.get(messageId);
    if (entry?.stored) {
      return false;
    }

    if (entry) {
      entry.updates.push(update);
      if (entry.updates.length > this.maxPerMessage) {
        entry.updates.shift();
      }
      return true;
    }

    this.insert(messageId, { expiresAt: this.now() + this.ttlMs, stored: false, updates: [update] });
    return true;
  }

  /** Call once the message is stored. Returns the updates held for it, oldest first. */
  public release(messageId: string): T[] {
    this.dropExpired();

    const held = this.entries.get(messageId)?.updates ?? [];
    this.entries.delete(messageId);
    this.insert(messageId, { expiresAt: this.now() + this.ttlMs, stored: true, updates: [] });

    return held;
  }

  public clear(): void {
    this.entries.clear();
  }

  private insert(messageId: string, entry: Entry<T>): void {
    this.entries.set(messageId, entry);

    while (this.entries.size > this.maxMessages) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  private dropExpired(): void {
    const now = this.now();

    for (const [messageId, entry] of this.entries) {
      if (entry.expiresAt > now) {
        break;
      }
      this.entries.delete(messageId);
    }
  }
}
