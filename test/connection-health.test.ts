import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConnectionHealth,
  ConnectionHealthReport,
  HEALTH_VERSION,
  isKeepAliveAnswer,
  isPersonJid,
  LiveState,
  LOOPING_CONFLICTS,
  LOOPING_DROPS,
  MAX_TRACKED_SENDS,
  RECONNECT_WINDOW_MS,
  UNACKED_STALL_MS,
  UNACKED_TTL_MS,
} from '../src/api/integrations/channel/whatsapp/connection-health';

const KEEP_ALIVE_MS = 30_000;
const CONNECTION_CLOSED = 428;
const CONNECTION_REPLACED = 440;

const START = Date.UTC(2026, 10, 21, 12, 0, 0);
const PERSON = '5511999999999@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
// The answer to a keep-alive ping as WhatsApp sends it (Baileys decodes the server JID with an empty user part).
const PING_ANSWER = { tag: 'iq', attrs: { from: '@s.whatsapp.net', type: 'result', id: '1.2-3', t: '1795312056' } };
const MESSAGE_FRAME = { tag: 'message', attrs: { from: PERSON, id: 'M1' }, content: [{ tag: 'enc', attrs: {} }] };

/** A tracker on a clock the test moves by hand, and a live state that reads 'open' unless a test says otherwise. */
function tracker() {
  const clock = { now: START };
  const health = new ConnectionHealth({ keepAliveIntervalMs: KEEP_ALIVE_MS, now: () => clock.now });
  const live: LiveState = {
    state: 'open',
    wsOpen: true,
    attempt: 0,
    nextRetryAt: null,
    queueOldestAgeMs: 0,
    queueItemTimeoutMs: 120_000,
  };
  const advance = (ms: number) => (clock.now += ms);
  const at = (offsetMs: number) => new Date(START + offsetMs).toISOString();

  return {
    health,
    live,
    clock,
    advance,
    at,
    report: (overrides: Partial<LiveState> = {}) => health.report({ ...live, ...overrides }),
  };
}

const counts = ({ reconnects: { opens, drops, conflicts } }: ConnectionHealthReport) => ({ opens, drops, conflicts });

/** An instance that connected and has just heard from WhatsApp. */
function opened() {
  const t = tracker();
  t.health.socketOpened();
  t.health.frameReceived(PING_ANSWER);
  return t;
}

describe('ConnectionHealth report', () => {
  it('starts with empty facts and the time tracking began', () => {
    const { report, at } = tracker();

    assert.deepEqual(report({ state: 'close', wsOpen: false }), {
      version: HEALTH_VERSION,
      observedSince: at(0),
      socket: { wsOpen: false, openedAt: null, lastFrameAt: null, lastKeepAliveAt: null },
      reconnects: {
        windowMs: RECONNECT_WINDOW_MS,
        opens: 0,
        drops: 0,
        conflicts: 0,
        attempt: 0,
        nextRetryAt: null,
        lastCloseCode: null,
        lastCloseAt: null,
      },
      inbound: { lastMessageAt: null },
      outbound: { lastAckAt: null, unacked: 0, oldestUnackedAt: null },
      verdict: 'closed',
      reasons: [],
    });
  });

  it('reports each fact at the time it happened', () => {
    const { health, report, advance, at } = tracker();

    advance(1_000);
    health.socketOpened();
    advance(1_000);
    health.frameReceived(MESSAGE_FRAME);
    health.messageReceived();
    advance(1_000);
    health.frameReceived(PING_ANSWER);
    advance(1_000);
    health.sent(PERSON, 'A');
    advance(1_000);
    health.frameReceived({ tag: 'ack', attrs: { class: 'message', id: 'A' } });
    health.acked('A');

    const result = report();

    assert.deepEqual(result.socket, {
      wsOpen: true,
      openedAt: at(1_000),
      lastFrameAt: at(5_000),
      lastKeepAliveAt: at(3_000),
    });
    assert.deepEqual(result.inbound, { lastMessageAt: at(2_000) });
    assert.deepEqual(result.outbound, { lastAckAt: at(5_000), unacked: 0, oldestUnackedAt: null });
    assert.equal(result.reconnects.opens, 1);
    assert.equal(result.verdict, 'ok');
  });

  it('carries no JIDs, message ids or text', () => {
    const { health, report } = opened();

    health.sent(PERSON, 'SECRET-ID');
    health.frameReceived(MESSAGE_FRAME);

    const text = JSON.stringify(report());

    assert.equal(text.includes('SECRET-ID'), false);
    assert.equal(text.includes('5511999999999'), false);
  });

  it('passes the backoff attempt and the next retry time through', () => {
    const { report, at } = tracker();

    const result = report({ state: 'connecting', wsOpen: false, attempt: 3, nextRetryAt: START + 5_000 });

    assert.equal(result.reconnects.attempt, 3);
    assert.equal(result.reconnects.nextRetryAt, at(5_000));
  });

  it('keeps the last close code and time', () => {
    const { health, report, advance, at } = opened();

    advance(2_000);
    health.socketClosed(CONNECTION_CLOSED);
    advance(2_000);
    health.socketClosed(undefined);

    assert.equal(report().reconnects.lastCloseCode, null);
    assert.equal(report().reconnects.lastCloseAt, at(4_000));
  });

  it('counts opens, drops and 440 closes only inside the window', () => {
    const { health, report, advance } = tracker();

    health.socketOpened();
    health.socketClosed(CONNECTION_REPLACED);
    health.socketClosed(CONNECTION_CLOSED);
    advance(RECONNECT_WINDOW_MS - 1);

    assert.deepEqual(counts(report()), { opens: 1, drops: 1, conflicts: 1 });

    advance(1);

    assert.deepEqual(counts(report()), { opens: 0, drops: 0, conflicts: 0 });
  });
});

describe('ConnectionHealth outbound', () => {
  it('counts a direct send until it is acked', () => {
    const { health, report, advance, at } = opened();

    advance(1_000);
    health.sent(PERSON, 'A');
    advance(1_000);
    health.sent('123456789@lid', 'B');

    assert.deepEqual(report().outbound, { lastAckAt: null, unacked: 2, oldestUnackedAt: at(1_000) });

    health.acked('A');

    assert.deepEqual(report().outbound, { lastAckAt: at(2_000), unacked: 1, oldestUnackedAt: at(2_000) });
  });

  it('never counts a group, broadcast or channel send, but takes its ack as an ack', () => {
    const { health, report, advance, at } = opened();

    health.sent(GROUP, 'G');
    health.sent('status@broadcast', 'S');
    health.sent('120363000000000001@newsletter', 'N');

    assert.equal(report().outbound.unacked, 0);

    advance(1_000);
    health.acked('G');

    assert.deepEqual(report().outbound, { lastAckAt: at(1_000), unacked: 0, oldestUnackedAt: null });
  });

  it('does not count a send whose ack was handled before the send returned', () => {
    const { health, report } = opened();

    health.acked('A');
    health.sent(PERSON, 'A');

    assert.equal(report().outbound.unacked, 0);

    // Only that once: a later send that reuses nothing is counted.
    health.sent(PERSON, 'B');
    assert.equal(report().outbound.unacked, 1);
  });

  it('clears a send on a receipt without moving lastAckAt', () => {
    const { health, report } = opened();

    health.sent(PERSON, 'A');
    health.receipted('A');

    assert.deepEqual(report().outbound, { lastAckAt: null, unacked: 0, oldestUnackedAt: null });
  });

  it('ignores a send without an id', () => {
    const { health, report } = opened();

    health.sent(PERSON, undefined);
    health.sent(PERSON, '');

    assert.equal(report().outbound.unacked, 0);
  });

  it('forgets a send that was never acked after the TTL', () => {
    const { health, report, advance } = opened();

    health.sent(PERSON, 'A');
    advance(UNACKED_TTL_MS);
    health.frameReceived(PING_ANSWER);

    assert.equal(report().outbound.unacked, 1);

    advance(1);

    assert.equal(report().outbound.unacked, 0);
  });

  it('tracks a bounded number of sends, dropping the oldest', () => {
    const { health, report, advance, at } = opened();

    health.sent(PERSON, 'first');
    advance(1_000);
    for (let i = 0; i < MAX_TRACKED_SENDS; i++) {
      health.sent(PERSON, `M${i}`);
    }

    assert.deepEqual(report().outbound, { lastAckAt: null, unacked: MAX_TRACKED_SENDS, oldestUnackedAt: at(1_000) });
  });
});

describe('ConnectionHealth verdict', () => {
  it('is ok for an open socket that keeps hearing from WhatsApp', () => {
    const { health, report, advance } = opened();

    for (let i = 0; i < 10; i++) {
      advance(KEEP_ALIVE_MS);
      health.frameReceived(PING_ANSWER);
    }

    assert.equal(report().verdict, 'ok');
    assert.deepEqual(report().reasons, []);
  });

  it('is closed when the state is close, whatever else is true', () => {
    const { health, report } = opened();

    for (let i = 0; i < LOOPING_CONFLICTS; i++) health.socketClosed(CONNECTION_REPLACED);

    assert.equal(report({ state: 'close', wsOpen: false }).verdict, 'closed');
    assert.equal(report({ state: 'refused', wsOpen: false }).verdict, 'closed');
    assert.equal(report({ state: undefined, wsOpen: false }).verdict, 'closed');
  });

  it('is reconnecting while a retry is scheduled or a socket is connecting', () => {
    const { health, report } = opened();

    health.socketClosed(CONNECTION_CLOSED);

    assert.equal(
      report({ state: 'connecting', wsOpen: false, attempt: 1, nextRetryAt: START + 1_000 }).verdict,
      'reconnecting',
    );
    assert.equal(report({ state: 'connecting', wsOpen: false, attempt: 1 }).verdict, 'reconnecting');
  });

  it('is reconnecting, not stalled, for a first connect that has not opened yet', () => {
    const { report, advance } = tracker();

    advance(10 * KEEP_ALIVE_MS);

    assert.equal(report({ state: 'connecting', wsOpen: false }).verdict, 'reconnecting');
  });

  it('does not call one drop and reconnect a loop', () => {
    const { health, report, advance } = opened();

    advance(60_000);
    health.socketClosed(CONNECTION_REPLACED);
    advance(1_000);
    health.socketOpened();
    health.frameReceived(PING_ANSWER);

    assert.equal(report().reconnects.opens, 2);
    assert.equal(report().reconnects.drops, 1);
    assert.equal(report().reconnects.conflicts, LOOPING_CONFLICTS - 1);
    assert.equal(report().verdict, 'ok');
  });

  it('does not call sockets replaced on purpose a loop', () => {
    const { health, report } = opened();

    // A restart, or a privacy or profile picture update: the socket is replaced and its close is never reported.
    for (let i = 0; i < 5; i++) {
      health.socketCreated();
      health.socketOpened();
      health.frameReceived(PING_ANSWER);
    }

    assert.equal(report().reconnects.opens, 6);
    assert.equal(report().reconnects.drops, 0);
    assert.equal(report().verdict, 'ok');
  });

  it('does not count a failed attempt as a drop', () => {
    const { health, report, advance } = opened();

    // One drop, then WhatsApp is unreachable: every retry closes before it opens.
    health.socketClosed(CONNECTION_CLOSED);
    for (let i = 0; i < 5; i++) {
      advance(1_000);
      health.socketCreated();
      health.socketClosed(CONNECTION_CLOSED);
    }

    const result = report({ state: 'connecting', wsOpen: false, attempt: 6 });

    assert.equal(result.reconnects.drops, 1);
    assert.equal(result.verdict, 'reconnecting');
  });

  it('does not count the close of a failed attempt after a replaced socket as a drop', () => {
    const { health, report } = opened();

    health.socketCreated();
    health.socketClosed(CONNECTION_CLOSED);

    assert.equal(report({ state: 'connecting', wsOpen: false }).reconnects.drops, 0);
  });

  it('is looping when the socket keeps reopening', () => {
    const { health, report, advance } = tracker();

    for (let i = 0; i < LOOPING_DROPS; i++) {
      health.socketCreated();
      health.socketOpened();
      health.frameReceived(PING_ANSWER);
      advance(5_000);
      health.socketClosed(CONNECTION_CLOSED);
    }

    const waiting = report({ state: 'connecting', wsOpen: false, attempt: 3, nextRetryAt: START + 60_000 });
    assert.equal(waiting.verdict, 'looping');
    assert.deepEqual(waiting.reasons, ['reconnect_loop']);

    health.socketOpened();
    assert.equal(report().verdict, 'looping');
  });

  it('is looping when another client keeps replacing the session, also between attempts', () => {
    const { health, report, advance } = tracker();

    // Two sockets on one session: every attempt opens and is replaced with 440 a moment later.
    for (let i = 0; i < LOOPING_CONFLICTS; i++) {
      health.socketOpened();
      advance(1_000);
      health.socketClosed(CONNECTION_REPLACED);
      advance(1_000);
    }

    const waiting = report({ state: 'connecting', wsOpen: false, attempt: 2, nextRetryAt: START + 10_000 });
    assert.equal(waiting.verdict, 'looping');
    assert.deepEqual(waiting.reasons, ['session_conflict']);
  });

  it('still reads looping once the backoff has slowed a 440 loop to one attempt per 5 min', () => {
    const { health, report, advance } = tracker();

    for (let i = 0; i < 6; i++) {
      health.socketOpened();
      advance(1_000);
      health.socketClosed(CONNECTION_REPLACED);
      advance(299_000);

      if (i > 0) {
        assert.equal(report({ state: 'connecting', wsOpen: false, attempt: 8 + i }).verdict, 'looping');
      }
    }
  });

  it('stops reading looping once the window has passed', () => {
    const { health, report, advance } = tracker();

    for (let i = 0; i < LOOPING_DROPS; i++) {
      health.socketOpened();
      health.socketClosed(CONNECTION_REPLACED);
    }
    health.socketOpened();
    assert.equal(report().verdict, 'looping');

    advance(RECONNECT_WINDOW_MS);
    health.frameReceived(PING_ANSWER);

    assert.equal(report().verdict, 'ok');
  });

  it('is stalled when the state reads open over a websocket that is not', () => {
    const { report } = opened();

    const result = report({ wsOpen: false });

    assert.equal(result.verdict, 'stalled');
    assert.deepEqual(result.reasons, ['ws_closed']);
  });

  it('is stalled once nothing was received for two keep-alive intervals', () => {
    const { report, advance } = opened();

    advance(2 * KEEP_ALIVE_MS);
    assert.equal(report().verdict, 'ok');

    advance(1);
    assert.equal(report().verdict, 'stalled');
    assert.deepEqual(report().reasons, ['keepalive_silent']);
  });

  it('counts the silence of a new socket from when it opened, not from the last frame of the old one', () => {
    const { health, report, advance } = opened();

    advance(10 * KEEP_ALIVE_MS);
    health.socketClosed(CONNECTION_CLOSED);
    health.socketOpened();

    assert.equal(report().verdict, 'ok');

    advance(2 * KEEP_ALIVE_MS + 1);

    assert.deepEqual(report().reasons, ['keepalive_silent']);
  });

  it('is stalled when the oldest queued event is past the item deadline', () => {
    const { report } = opened();

    assert.equal(report({ queueOldestAgeMs: 120_000 }).verdict, 'ok');

    const result = report({ queueOldestAgeMs: 120_001 });

    assert.equal(result.verdict, 'stalled');
    assert.deepEqual(result.reasons, ['queue_stuck']);
  });

  it('is stalled when a direct send stays unacked and nothing was received since', () => {
    const { health, report, advance } = opened();

    advance(1_000);
    health.sent(PERSON, 'A');
    advance(UNACKED_STALL_MS);
    assert.equal(report().verdict, 'ok');

    advance(1);
    assert.equal(report().verdict, 'stalled');
    assert.deepEqual(report().reasons, ['sends_unacked']);
  });

  it('does not stall on an unacked send while frames still arrive', () => {
    const { health, report, advance } = opened();

    health.sent(PERSON, 'A');
    advance(UNACKED_STALL_MS + 1);
    health.frameReceived(PING_ANSWER);

    const result = report();

    assert.equal(result.outbound.unacked, 1);
    assert.equal(result.verdict, 'ok');
  });

  it('lists every reason that applies', () => {
    const { health, report, advance } = opened();

    health.sent(PERSON, 'A');
    advance(2 * KEEP_ALIVE_MS + 1);

    const result = report({ wsOpen: false, queueOldestAgeMs: 500_000 });

    assert.equal(result.verdict, 'stalled');
    assert.deepEqual(result.reasons, ['ws_closed', 'keepalive_silent', 'queue_stuck', 'sends_unacked']);
  });
});

describe('isKeepAliveAnswer', () => {
  it('matches an empty iq result with the server time, from the server', () => {
    assert.equal(isKeepAliveAnswer(PING_ANSWER), true);
    assert.equal(isKeepAliveAnswer({ ...PING_ANSWER, content: [] }), true);
    assert.equal(isKeepAliveAnswer({ ...PING_ANSWER, attrs: { ...PING_ANSWER.attrs, from: 's.whatsapp.net' } }), true);
  });

  it('does not match other frames', () => {
    const { t, ...withoutTime } = PING_ANSWER.attrs;

    assert.ok(t);
    assert.equal(isKeepAliveAnswer(MESSAGE_FRAME), false);
    assert.equal(isKeepAliveAnswer({ ...PING_ANSWER, content: [{ tag: 'props', attrs: {} }] }), false);
    assert.equal(isKeepAliveAnswer({ ...PING_ANSWER, attrs: withoutTime }), false);
    assert.equal(isKeepAliveAnswer({ ...PING_ANSWER, attrs: { ...PING_ANSWER.attrs, type: 'error' } }), false);
    assert.equal(isKeepAliveAnswer({ ...PING_ANSWER, attrs: { ...PING_ANSWER.attrs, from: GROUP } }), false);
    assert.equal(isKeepAliveAnswer({ tag: 'iq' }), false);
    assert.equal(isKeepAliveAnswer(new Uint8Array([1, 2, 3])), false);
    assert.equal(isKeepAliveAnswer(undefined), false);
  });
});

describe('isPersonJid', () => {
  it('is true for a phone number or LID chat only', () => {
    assert.equal(isPersonJid(PERSON), true);
    assert.equal(isPersonJid('123456789@lid'), true);
    assert.equal(isPersonJid('5511999999999@c.us'), true);

    assert.equal(isPersonJid(GROUP), false);
    assert.equal(isPersonJid('status@broadcast'), false);
    assert.equal(isPersonJid('120363000000000001@newsletter'), false);
    assert.equal(isPersonJid(undefined), false);
  });
});
