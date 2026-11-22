import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PendingMessageUpdates } from '../src/api/integrations/channel/whatsapp/pending-message-updates';

/** A buffer on a clock the test moves by hand. */
function buffer(options: { ttlMs?: number; maxMessages?: number; maxPerMessage?: number } = {}) {
  const clock = { now: 0 };
  const pending = new PendingMessageUpdates<string>({ ttlMs: 60_000, ...options, now: () => clock.now });
  return { pending, clock };
}

describe('PendingMessageUpdates', () => {
  it('hands the held updates back, oldest first, when the message is stored', () => {
    const { pending } = buffer();

    assert.equal(pending.hold('A', 'server-ack'), true);
    assert.equal(pending.hold('A', 'delivery-ack'), true);
    assert.equal(pending.hold('B', 'other'), true);

    assert.deepEqual(pending.release('A'), ['server-ack', 'delivery-ack']);
    assert.deepEqual(pending.release('B'), ['other']);
  });

  it('releases each update once', () => {
    const { pending } = buffer();

    pending.hold('A', 'server-ack');

    assert.deepEqual(pending.release('A'), ['server-ack']);
    assert.deepEqual(pending.release('A'), []);
  });

  it('returns nothing for a message with no held update', () => {
    assert.deepEqual(buffer().pending.release('A'), []);
  });

  it('refuses an update for a message that was just stored, so the caller looks it up again', () => {
    const { pending } = buffer();

    pending.release('A');

    assert.equal(pending.hold('A', 'server-ack'), false);
    assert.deepEqual(pending.release('A'), []);
  });

  it('forgets a stored message after the TTL', () => {
    const { pending, clock } = buffer();

    pending.release('A');
    clock.now = 60_000;

    assert.equal(pending.hold('A', 'server-ack'), true);
  });

  it('drops an update whose message is not stored within the TTL', () => {
    const { pending, clock } = buffer();

    pending.hold('A', 'server-ack');
    clock.now = 59_999;
    assert.equal(pending.size, 1);

    clock.now = 60_000;
    assert.equal(pending.size, 0);
    assert.deepEqual(pending.release('A'), []);
  });

  it('does not extend the wait when another update arrives for the same message', () => {
    const { pending, clock } = buffer();

    pending.hold('A', 'server-ack');
    clock.now = 50_000;
    pending.hold('A', 'delivery-ack');
    clock.now = 60_000;

    assert.deepEqual(pending.release('A'), []);
  });

  it('keeps younger entries when older ones expire', () => {
    const { pending, clock } = buffer();

    pending.hold('A', 'old');
    clock.now = 30_000;
    pending.hold('B', 'young');
    clock.now = 60_000;

    assert.equal(pending.size, 1);
    assert.deepEqual(pending.release('B'), ['young']);
  });

  it('drops the oldest message past the cap', () => {
    const { pending } = buffer({ maxMessages: 2 });

    pending.hold('A', 'a');
    pending.hold('B', 'b');
    pending.hold('C', 'c');

    assert.equal(pending.size, 2);
    assert.deepEqual(pending.release('B'), ['b']);
    assert.deepEqual(pending.release('C'), ['c']);
    assert.deepEqual(pending.release('A'), []);
  });

  it('keeps the newest updates of one message past the per-message cap', () => {
    const { pending } = buffer({ maxPerMessage: 2 });

    pending.hold('A', 'one');
    pending.hold('A', 'two');
    pending.hold('A', 'three');

    assert.deepEqual(pending.release('A'), ['two', 'three']);
  });

  it('clear() drops held updates and stored ids', () => {
    const { pending } = buffer();

    pending.hold('A', 'server-ack');
    pending.release('B');
    pending.clear();

    assert.equal(pending.size, 0);
    assert.deepEqual(pending.release('A'), []);
    assert.equal(pending.hold('B', 'server-ack'), true);
  });
});
