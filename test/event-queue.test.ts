import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BaileysEventQueue,
  deserializeEvents,
  EventMap,
  HISTORY_EVENT,
  HistoryPart,
} from '../src/api/integrations/channel/whatsapp/baileys-event-queue';

/** A Redis stream in memory, with the calls the queue makes. Survives the queue, as Redis survives a restart. */
function fakeRedis() {
  const streams = new Map<string, { id: string; message: Record<string, string> }[]>();
  let seq = 0;
  const stream = (key: string) => {
    if (!streams.has(key)) streams.set(key, []);
    return streams.get(key);
  };

  const redis = {
    isReady: true,
    isOpen: true,
    async xAdd(key: string, _id: string, message: Record<string, string>) {
      const id = `${Date.now()}-${seq++}`;
      stream(key).push({ id, message });
      return id;
    },
    async xRange(key: string) {
      return [...stream(key)];
    },
    async xDel(key: string, id: string) {
      const entries = stream(key);
      const at = entries.findIndex((entry) => entry.id === id);
      if (at >= 0) entries.splice(at, 1);
      return at >= 0 ? 1 : 0;
    },
    async del(key: string) {
      streams.delete(key);
    },
  };

  return { redis, entries: (key: string) => stream(key) };
}

function queue(redis: any, maxEntryBytes: number, warnings: string[] = []) {
  return new BaileysEventQueue({
    instanceId: 'test',
    logger: { info: () => undefined, warn: (value) => warnings.push(String(value)), error: () => undefined },
    redis,
    prefix: 'test',
    itemTimeoutMs: 5_000,
    maxEntryBytes,
    maxLength: 10_000,
  });
}

/** A history batch of `count` messages of about `size` bytes each, over `chats` chats. */
function historyBatch(count: number, size: number, chats = 4) {
  const jid = (i: number) => `55119${String(i % chats).padStart(8, '0')}@s.whatsapp.net`;
  return {
    chats: Array.from({ length: chats }, (_, i) => ({ id: jid(i), unreadCount: i })),
    contacts: Array.from({ length: chats }, (_, i) => ({ id: jid(i), name: `Contact ${i}` })),
    messages: Array.from({ length: count }, (_, i) => ({
      key: { id: `M${i}`, remoteJid: jid(i), fromMe: false },
      messageTimestamp: 1_700_000_000 + i,
      message: { conversation: 'x'.repeat(size) },
    })),
    lidPnMappings: [{ lid: '1@lid', pn: jid(0) }],
    isLatest: true,
    progress: 100,
    syncType: 2,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const ids = (parts: EventMap[]) => parts.flatMap((part) => part[HISTORY_EVENT]?.messages.map((m) => m.key.id) ?? []);

describe('event queue: history batches over EVENT_QUEUE_MAX_ENTRY_BYTES (see #74)', () => {
  it('persists a batch under the cap as one entry, unchanged', async () => {
    const { redis, entries } = fakeRedis();
    const q = queue(redis, 1024 * 1024);
    const events = { [HISTORY_EVENT]: historyBatch(10, 100), 'creds.update': {} };
    const seen: EventMap[] = [];
    let release: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));

    q.submit(events, async (part) => {
      await held;
      seen.push(part);
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(entries('test:evq:test').length, 1);

    release();
    await settle();
    assert.equal(seen.length, 1);
    assert.equal(seen[0], events);
    assert.equal(entries('test:evq:test').length, 0);
  });

  it('splits an oversize history batch into persisted parts that cover every message once, in order', async () => {
    const { redis, entries } = fakeRedis();
    const max = 64 * 1024;
    const warnings: string[] = [];
    const q = queue(redis, max, warnings);
    const history = historyBatch(400, 1000);
    const upsert = { messages: [{ key: { id: 'LIVE' } }], type: 'append' };
    const events = { 'creds.update': {}, [HISTORY_EVENT]: history, 'messages.upsert': upsert };
    const seen: EventMap[] = [];
    let release: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));

    q.submit(events, async (part) => {
      await held;
      seen.push(part);
    });
    await new Promise((resolve) => setImmediate(resolve));

    const persisted = [...entries('test:evq:test')];
    assert.ok(persisted.length > 2, `${persisted.length} entries`);
    for (const entry of persisted) {
      assert.ok(Buffer.byteLength(entry.message.e) <= max, `entry of ${Buffer.byteLength(entry.message.e)} bytes`);
    }
    assert.deepEqual(warnings, []);

    release();
    await settle();

    assert.equal(seen.length, persisted.length);
    const historyParts = seen.filter((part) => part[HISTORY_EVENT]);
    assert.deepEqual(
      ids(historyParts),
      history.messages.map((m) => m.key.id),
    );

    const first = historyParts[0][HISTORY_EVENT];
    const last = historyParts[historyParts.length - 1][HISTORY_EVENT];
    // Socket-lifecycle events stay ahead of the history, other data events after it.
    assert.ok('creds.update' in historyParts[0]);
    assert.deepEqual(seen[seen.length - 1], { 'messages.upsert': upsert });
    // Chats and batch fields only in the first part, progress and isLatest only in the last, contacts in all.
    assert.equal(first.chats.length, 4);
    assert.deepEqual(first.lidPnMappings, history.lidPnMappings);
    assert.equal(first.isLatest, undefined);
    assert.equal(first.progress, undefined);
    assert.deepEqual([last.isLatest, last.progress], [true, 100]);
    for (const part of historyParts.slice(1)) {
      assert.deepEqual(part[HISTORY_EVENT].chats, []);
      assert.equal(part[HISTORY_EVENT].contacts.length, 4);
      assert.equal(part[HISTORY_EVENT].syncType, 2);
    }
    const ranges = historyParts.map((part) => part[HISTORY_EVENT].queuePart as HistoryPart);
    assert.deepEqual(ranges[0].from, 0);
    assert.deepEqual(ranges[ranges.length - 1].to, 400);
    ranges.slice(1).forEach((range, i) => assert.equal(range.from, ranges[i].to));

    assert.equal(entries('test:evq:test').length, 0);
  });

  it('persists a 36 MiB history batch under the default 8 MiB cap', async () => {
    const { redis, entries } = fakeRedis();
    const max = 8 * 1024 * 1024;
    const warnings: string[] = [];
    const q = queue(redis, max, warnings);
    const history = historyBatch(9_000, 4_200, 300);
    let release: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));

    q.submit({ [HISTORY_EVENT]: history }, () => held);
    await new Promise((resolve) => setImmediate(resolve));

    const persisted = [...entries('test:evq:test')];
    const bytes = persisted.map((entry) => Buffer.byteLength(entry.message.e));
    assert.ok(
      bytes.reduce((a, b) => a + b, 0) > 36 * 1024 * 1024,
      `${bytes.reduce((a, b) => a + b, 0)} bytes in total`,
    );
    assert.ok(Math.max(...bytes) <= max);
    assert.deepEqual(warnings, []);
    assert.equal(
      ids(persisted.map((entry) => deserializeEvents(entry.message.e))).length,
      9_000,
    );

    release();
    await settle();
  });

  it('completes an import interrupted by a restart, with the same messages as an uninterrupted one', async () => {
    const { redis, entries } = fakeRedis();
    const max = 64 * 1024;
    const history = historyBatch(400, 1000);
    const stored = new Set<string>();

    // First process: two parts are processed, then it "dies": the rest is neither stored nor deleted from the stream.
    const before = queue(redis, max);
    let processed = 0;
    before.submit({ [HISTORY_EVENT]: history }, async (part) => {
      if (processed++ >= 2) {
        redis.isOpen = false;
        return;
      }
      for (const id of ids([part])) stored.add(id);
    });
    await settle();
    redis.isOpen = true;

    const left = entries('test:evq:test').length;
    assert.ok(left > 0 && stored.size > 0 && stored.size < 400, `${left} left, ${stored.size} stored`);

    // Second process: replay finds the parts not yet processed.
    const after = queue(redis, max);
    const replayed: EventMap[] = [];
    after.replay(async (part) => {
      replayed.push(part);
      for (const id of ids([part])) stored.add(id);
    });
    await settle();

    assert.equal(replayed.length, left);
    assert.equal(stored.size, 400);
    assert.deepEqual([...stored].sort(), history.messages.map((m) => m.key.id).sort());
    assert.equal(entries('test:evq:test').length, 0);
  });

  it('processes without persisting a part that cannot shrink under the cap, and persists the rest', async () => {
    const { redis, entries } = fakeRedis();
    const max = 64 * 1024;
    const warnings: string[] = [];
    const q = queue(redis, max, warnings);
    const history = historyBatch(100, 1000);
    history.messages[50].message.conversation = 'y'.repeat(2 * max);
    const seen: EventMap[] = [];
    let release: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));

    q.submit({ [HISTORY_EVENT]: history }, async (part) => {
      await held;
      seen.push(part);
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /over EVENT_QUEUE_MAX_ENTRY_BYTES/);
    const persistedIds = ids(entries('test:evq:test').map((entry) => deserializeEvents(entry.message.e)));
    assert.equal(persistedIds.length, 99);
    assert.ok(!persistedIds.includes('M50'));

    release();
    await settle();
    assert.equal(ids(seen).length, 100);
  });

  it('does not split a batch it cannot persist anyway', async () => {
    const q = queue(null, 1024);
    const events = { [HISTORY_EVENT]: historyBatch(100, 1000) };
    const seen: EventMap[] = [];

    q.submit(events, async (part) => {
      seen.push(part);
    });
    await settle();

    assert.deepEqual(seen, [events]);
  });
});
