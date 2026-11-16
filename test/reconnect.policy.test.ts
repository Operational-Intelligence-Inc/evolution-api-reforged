import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CloseContext,
  decideOnClose,
  nextConflictCount,
  RECONNECT_DELAYS_MS,
  reconnectDelayMs,
} from '../src/api/integrations/channel/whatsapp/reconnect.policy';

const LOGGED_OUT = 401;
const FORBIDDEN = 403;
const TIMED_OUT = 408;
const CONNECTION_CLOSED = 428;
const CONNECTION_REPLACED = 440;
const BAD_SESSION = 500;
const RESTART_REQUIRED = 515;

const QR_LIMIT = 30;
const CONFLICT_LIMIT = 10;

/** A linked session that dropped, with no QR codes shown and no 440 streak. */
function ctx(overrides: Partial<CloseContext> = {}): CloseContext {
  return {
    statusCode: CONNECTION_CLOSED,
    paired: true,
    qrCount: 0,
    qrLimit: QR_LIMIT,
    conflictCount: 0,
    conflictLimit: CONFLICT_LIMIT,
    ...overrides,
  };
}

describe('reconnectDelayMs', () => {
  it('reconnects at once on the first 515 (restart after pairing)', () => {
    assert.equal(reconnectDelayMs(1, RESTART_REQUIRED), 0);
  });

  it('backs off on a repeated 515', () => {
    assert.equal(reconnectDelayMs(2, RESTART_REQUIRED), RECONNECT_DELAYS_MS[1]);
  });

  it('follows the delay table and repeats the last value', () => {
    RECONNECT_DELAYS_MS.forEach((delay, index) => assert.equal(reconnectDelayMs(index + 1, CONNECTION_CLOSED), delay));
    assert.equal(reconnectDelayMs(100, CONNECTION_CLOSED), RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1]);
    assert.equal(reconnectDelayMs(0), RECONNECT_DELAYS_MS[0]);
  });
});

describe('nextConflictCount', () => {
  it('counts consecutive 440 closes', () => {
    assert.equal(nextConflictCount(0, CONNECTION_REPLACED), 1);
    assert.equal(nextConflictCount(4, CONNECTION_REPLACED), 5);
  });

  it('resets on any other close code', () => {
    for (const code of [undefined, TIMED_OUT, CONNECTION_CLOSED, BAD_SESSION, RESTART_REQUIRED]) {
      assert.equal(nextConflictCount(7, code), 0);
    }
  });
});

describe('decideOnClose', () => {
  it('stops on non-retryable codes', () => {
    for (const statusCode of [LOGGED_OUT, FORBIDDEN, 402, 406]) {
      assert.deepEqual(decideOnClose(ctx({ statusCode })), { action: 'stop', reason: 'not-retryable' });
    }
  });

  describe('linked session (#10, #51 unchanged)', () => {
    it('retries 428/408/500 and a close without a code, with no cap', () => {
      for (const statusCode of [CONNECTION_CLOSED, TIMED_OUT, BAD_SESSION, undefined]) {
        assert.deepEqual(decideOnClose(ctx({ statusCode })), { action: 'retry' });
      }
    });

    it('ignores a stale QR count', () => {
      assert.deepEqual(decideOnClose(ctx({ qrCount: QR_LIMIT + 5 })), { action: 'retry' });
    });
  });

  describe('unscanned QR pairing', () => {
    const pairing = (overrides: Partial<CloseContext>) => ctx({ paired: false, ...overrides });

    it('retries while fewer than QRCODE_LIMIT codes were shown', () => {
      for (const statusCode of [CONNECTION_CLOSED, TIMED_OUT]) {
        assert.deepEqual(decideOnClose(pairing({ statusCode, qrCount: 0 })), { action: 'retry' });
        assert.deepEqual(decideOnClose(pairing({ statusCode, qrCount: QR_LIMIT - 1 })), { action: 'retry' });
      }
    });

    it('stops once QRCODE_LIMIT codes were shown', () => {
      for (const statusCode of [CONNECTION_CLOSED, TIMED_OUT, BAD_SESSION, undefined]) {
        assert.deepEqual(decideOnClose(pairing({ statusCode, qrCount: QR_LIMIT })), {
          action: 'stop',
          reason: 'qr-limit',
        });
        assert.deepEqual(decideOnClose(pairing({ statusCode, qrCount: QR_LIMIT + 3 })), {
          action: 'stop',
          reason: 'qr-limit',
        });
      }
    });

    it('never stops a 515 (a scan), even at or past the limit', () => {
      assert.deepEqual(decideOnClose(pairing({ statusCode: RESTART_REQUIRED, qrCount: QR_LIMIT })), {
        action: 'retry',
      });
      assert.deepEqual(decideOnClose(pairing({ statusCode: RESTART_REQUIRED, qrCount: QR_LIMIT + 10 })), {
        action: 'retry',
      });
    });

    it('a just-scanned pairing (creds paired) that drops before open is retried, not stopped', () => {
      assert.deepEqual(decideOnClose(ctx({ paired: true, statusCode: CONNECTION_CLOSED, qrCount: QR_LIMIT })), {
        action: 'retry',
      });
    });

    it('treats a QRCODE_LIMIT of 0 as no limit', () => {
      assert.deepEqual(decideOnClose(pairing({ qrLimit: 0, qrCount: 100 })), { action: 'retry' });
    });
  });

  describe('440 (connectionReplaced)', () => {
    it('retries below RECONNECT_CONFLICT_LIMIT consecutive 440s', () => {
      for (let count = 1; count < CONFLICT_LIMIT; count++) {
        assert.deepEqual(decideOnClose(ctx({ statusCode: CONNECTION_REPLACED, conflictCount: count })), {
          action: 'retry',
        });
      }
    });

    it('stops but keeps the session at the limit', () => {
      assert.deepEqual(decideOnClose(ctx({ statusCode: CONNECTION_REPLACED, conflictCount: CONFLICT_LIMIT })), {
        action: 'stop-keep-session',
        reason: 'conflict-limit',
      });
    });

    it('RECONNECT_CONFLICT_LIMIT=0 retries forever', () => {
      assert.deepEqual(decideOnClose(ctx({ statusCode: CONNECTION_REPLACED, conflictCount: 1000, conflictLimit: 0 })), {
        action: 'retry',
      });
    });

    it('a streak only counts against 440 closes', () => {
      // The caller resets the streak on other codes; the decision itself only applies the cap to a 440.
      assert.deepEqual(decideOnClose(ctx({ statusCode: CONNECTION_CLOSED, conflictCount: CONFLICT_LIMIT })), {
        action: 'retry',
      });
    });

    it('a streak broken by another code starts over', () => {
      let count = 0;
      const sequence = [
        ...Array(CONFLICT_LIMIT - 1).fill(CONNECTION_REPLACED),
        CONNECTION_CLOSED,
        ...Array(CONFLICT_LIMIT - 1).fill(CONNECTION_REPLACED),
      ];
      for (const statusCode of sequence) {
        count = nextConflictCount(count, statusCode);
        assert.deepEqual(decideOnClose(ctx({ statusCode, conflictCount: count })), { action: 'retry' });
      }
      count = nextConflictCount(count, CONNECTION_REPLACED);
      assert.equal(count, CONFLICT_LIMIT);
      const decision = decideOnClose(ctx({ statusCode: CONNECTION_REPLACED, conflictCount: count }));
      assert.equal(decision.action, 'stop-keep-session');
    });
  });
});
