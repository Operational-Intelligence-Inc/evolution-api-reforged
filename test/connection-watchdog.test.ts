import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BaileysEventQueue } from '../src/api/integrations/channel/whatsapp/baileys-event-queue';
import { ConnectionHealth, LiveState } from '../src/api/integrations/channel/whatsapp/connection-health';
import {
  ConnectionWatchdog,
  DEFAULT_WATCHDOG_MAX_REBUILDS,
  DEFAULT_WATCHDOG_MODE,
  parseWatchdogMaxRebuilds,
  parseWatchdogMode,
  WATCHDOG_CHECK_INTERVAL_MS,
  WATCHDOG_CONFIRM_MS,
  WATCHDOG_HEALTHY_MS,
  WatchdogDecision,
  WatchdogInput,
  WatchdogMode,
} from '../src/api/integrations/channel/whatsapp/connection-watchdog';
import { RECONNECT_DELAYS_MS } from '../src/api/integrations/channel/whatsapp/reconnect.policy';

const START = Date.UTC(2026, 10, 21, 12, 0, 0);
const OPEN: WatchdogInput = { state: 'open', busy: false, reasons: [], queueProcessed: 0 };

/** A watchdog on a clock the test moves by hand. `check` advances the clock by `ms` first. */
function watchdog(mode: WatchdogMode = 'on', maxRebuilds = DEFAULT_WATCHDOG_MAX_REBUILDS) {
  const clock = { now: START };
  const dog = new ConnectionWatchdog({ mode, maxRebuilds, now: () => clock.now });

  const check = (input: Partial<WatchdogInput> = {}, ms = 0): WatchdogDecision => {
    clock.now += ms;
    return dog.check({ ...OPEN, ...input });
  };

  /** Checks every WATCHDOG_CHECK_INTERVAL_MS for `ms`, and returns every decision that was not 'none'. */
  const run = (input: Partial<WatchdogInput>, ms: number): WatchdogDecision[] => {
    const decisions: WatchdogDecision[] = [];
    for (let elapsed = 0; elapsed < ms; elapsed += WATCHDOG_CHECK_INTERVAL_MS) {
      const decision = check(input, WATCHDOG_CHECK_INTERVAL_MS);
      if (decision.action !== 'none') decisions.push(decision);
    }
    return decisions;
  };

  /** Holds the trigger until the next rebuild and finishes it. Returns the rebuild time. */
  const rebuild = (reasons: string[] = ['keepalive_silent']) => {
    for (let i = 0; i < 1000; i++) {
      const decision = check({ reasons }, 1_000);
      if (decision.action === 'rebuild') {
        dog.rebuildFinished();
        return clock.now;
      }
      assert.equal(decision.action, 'none');
    }
    throw new Error('no rebuild');
  };

  return { dog, clock, check, run, rebuild };
}

describe('connection watchdog (see #69)', () => {
  describe('triggers', () => {
    it('rebuilds once a trigger has held for the confirmation period', () => {
      const w = watchdog();

      assert.deepEqual(w.check({ reasons: ['keepalive_silent'] }), { action: 'none' });
      assert.deepEqual(w.check({ reasons: ['keepalive_silent'] }, WATCHDOG_CONFIRM_MS - 1), { action: 'none' });
      assert.deepEqual(w.check({ reasons: ['keepalive_silent'] }, 1), {
        action: 'rebuild',
        reason: 'keepalive_silent',
        attempt: 1,
      });
    });

    it('a trigger that clears in between starts its confirmation again', () => {
      const w = watchdog();

      w.check({ reasons: ['ws_closed'] });
      w.check({ reasons: [] }, WATCHDOG_CONFIRM_MS - 1_000);
      assert.equal(w.check({ reasons: ['ws_closed'] }, 1_000).action, 'none');
      assert.equal(w.check({ reasons: ['ws_closed'] }, WATCHDOG_CONFIRM_MS - 1).action, 'none');
      assert.equal(w.check({ reasons: ['ws_closed'] }, 1).action, 'rebuild');
    });

    it('unacked sends alone never trigger a rebuild', () => {
      const w = watchdog();
      assert.deepEqual(w.run({ reasons: ['sends_unacked'] }, 30 * 60_000), []);
    });

    it('picks ws_closed, then keepalive_silent, then queue_stuck', () => {
      const w = watchdog();

      w.check({ reasons: ['queue_stuck', 'keepalive_silent', 'ws_closed'] });
      const decision = w.check({ reasons: ['queue_stuck', 'keepalive_silent', 'ws_closed'] }, WATCHDOG_CONFIRM_MS);

      assert.deepEqual(decision, { action: 'rebuild', reason: 'ws_closed', attempt: 1 });
    });

    it('names the trigger that was confirmed, not one that has just begun', () => {
      const w = watchdog();

      w.check({ reasons: ['keepalive_silent'] });
      const decision = w.check({ reasons: ['keepalive_silent', 'ws_closed'] }, WATCHDOG_CONFIRM_MS);

      assert.deepEqual(decision, { action: 'rebuild', reason: 'keepalive_silent', attempt: 1 });
    });

    it('a queue that is old but moving is a backlog, not a trigger', () => {
      const w = watchdog();
      let processed = 0;

      for (let i = 0; i < 20; i++) {
        processed++;
        assert.equal(
          w.check({ reasons: ['queue_stuck'], queueProcessed: processed }, WATCHDOG_CHECK_INTERVAL_MS).action,
          'none',
        );
      }

      // It stops moving: the confirmation counts from the last item that left it.
      w.check({ reasons: ['queue_stuck'], queueProcessed: processed }, WATCHDOG_CONFIRM_MS - 1);
      assert.deepEqual(w.check({ reasons: ['queue_stuck'], queueProcessed: processed }, 1), {
        action: 'rebuild',
        reason: 'queue_stuck',
        attempt: 1,
      });
    });
  });

  describe('when it stays out of the way', () => {
    for (const state of ['connecting', 'close', undefined]) {
      it(`does nothing while the state reads ${state}`, () => {
        const w = watchdog();
        assert.deepEqual(w.run({ state, reasons: ['ws_closed', 'keepalive_silent'] }, 10 * 60_000), []);
      });
    }

    it('does nothing while a pairing, a scheduled reconnect or a socket creation owns the socket', () => {
      const w = watchdog();
      assert.deepEqual(w.run({ busy: true, reasons: ['ws_closed'] }, 10 * 60_000), []);
    });

    it('a busy moment restarts the confirmation', () => {
      const w = watchdog();

      w.check({ reasons: ['ws_closed'] });
      w.check({ busy: true, reasons: ['ws_closed'] }, WATCHDOG_CONFIRM_MS - 1_000);
      assert.equal(w.check({ reasons: ['ws_closed'] }, 1_000).action, 'none');
      assert.equal(w.check({ reasons: ['ws_closed'] }, WATCHDOG_CONFIRM_MS).action, 'rebuild');
    });

    it('never starts a second rebuild while one is in progress', () => {
      const w = watchdog();

      w.check({ reasons: ['ws_closed'] });
      assert.equal(w.check({ reasons: ['ws_closed'] }, WATCHDOG_CONFIRM_MS).action, 'rebuild');
      // The rebuilt socket has not reported yet, and the old facts still read stalled.
      assert.deepEqual(w.run({ reasons: ['ws_closed'] }, 10 * 60_000), []);

      w.dog.rebuildFinished();
      w.check({ reasons: ['ws_closed'] });
      assert.equal(w.check({ reasons: ['ws_closed'] }, WATCHDOG_CONFIRM_MS).action, 'rebuild');
    });

    it('mode off never acts', () => {
      const w = watchdog('off');
      assert.deepEqual(w.run({ reasons: ['ws_closed', 'keepalive_silent', 'queue_stuck'] }, 60 * 60_000), []);
      assert.equal(w.dog.report().mode, 'off');
    });
  });

  describe('limits', () => {
    it('backs off between rebuilds on the schedule of retried closes', () => {
      const w = watchdog('on', 20);
      const times = [w.rebuild()];

      for (let i = 1; i < 10; i++) {
        times.push(w.rebuild());
      }

      for (let n = 1; n < times.length; n++) {
        const gap = times[n] - times[n - 1];
        assert.ok(gap >= RECONNECT_DELAYS_MS[Math.min(n, RECONNECT_DELAYS_MS.length) - 1], `gap ${n}: ${gap}`);
        assert.ok(gap >= WATCHDOG_CONFIRM_MS, `gap ${n}: ${gap}`);
      }

      // The longest delay is reached and held: 5 min between rebuilds.
      assert.ok(times[9] - times[8] >= 300_000);
      assert.ok(times[9] - times[8] < 300_000 + 2_000);
    });

    it('gives up after maxRebuilds rebuilds without a healthy socket, and says so once', () => {
      const w = watchdog('on', 3);

      w.rebuild();
      w.rebuild();
      w.rebuild();

      const decisions = w.run({ reasons: ['keepalive_silent'] }, 60 * 60_000);
      assert.deepEqual(decisions, [{ action: 'give-up', reason: 'keepalive_silent', rebuilds: 3 }]);

      const report = w.dog.report();
      assert.equal(report.gaveUp, true);
      assert.equal(report.rebuilds, 3);
      assert.equal(report.lastReason, 'keepalive_silent');
    });

    it('a socket that stays healthy resets the rebuild count', () => {
      const w = watchdog('on', 2);

      w.rebuild();
      w.rebuild();
      // The second rebuild produced a socket that works.
      assert.deepEqual(w.run({ reasons: [] }, WATCHDOG_HEALTHY_MS + WATCHDOG_CHECK_INTERVAL_MS), []);

      assert.deepEqual(w.run({ reasons: ['ws_closed'] }, WATCHDOG_CONFIRM_MS + WATCHDOG_CHECK_INTERVAL_MS), [
        { action: 'rebuild', reason: 'ws_closed', attempt: 1 },
      ]);
      assert.equal(w.dog.report().rebuilds, 3);
    });

    it('a socket open for less than the healthy period does not reset the count', () => {
      const w = watchdog('on', 2);

      w.rebuild();
      w.run({ reasons: [] }, WATCHDOG_HEALTHY_MS - WATCHDOG_CHECK_INTERVAL_MS);
      w.rebuild();
      w.run({ reasons: [] }, WATCHDOG_HEALTHY_MS - WATCHDOG_CHECK_INTERVAL_MS);

      const decisions = w.run({ reasons: ['ws_closed'] }, 10 * 60_000);
      assert.deepEqual(decisions, [{ action: 'give-up', reason: 'ws_closed', rebuilds: 2 }]);
    });

    it('a watchdog that gave up resumes once the socket is healthy again', () => {
      const w = watchdog('on', 1);

      w.rebuild();
      w.run({ reasons: ['ws_closed'] }, 5 * 60_000);
      assert.equal(w.dog.report().gaveUp, true);

      // The reconnect logic or the network brought it back.
      w.run({ reasons: [] }, WATCHDOG_HEALTHY_MS + WATCHDOG_CHECK_INTERVAL_MS);
      assert.equal(w.dog.report().gaveUp, false);
      assert.equal(w.run({ reasons: ['ws_closed'] }, 5 * 60_000)[0].action, 'rebuild');
    });

    it('reset() (a connect or restart through the API) resumes a watchdog that gave up', () => {
      const w = watchdog('on', 1);

      w.rebuild();
      w.run({ reasons: ['ws_closed'] }, 5 * 60_000);
      assert.equal(w.dog.report().gaveUp, true);

      w.dog.reset();
      assert.equal(w.dog.report().gaveUp, false);
      assert.deepEqual(w.run({ reasons: ['ws_closed'] }, WATCHDOG_CONFIRM_MS + WATCHDOG_CHECK_INTERVAL_MS), [
        { action: 'rebuild', reason: 'ws_closed', attempt: 1 },
      ]);
    });
  });

  describe('report mode', () => {
    it('never rebuilds, and reports each would-be rebuild once', () => {
      const w = watchdog('report');

      const decisions = w.run({ reasons: ['keepalive_silent'] }, 60 * 60_000);
      assert.deepEqual(decisions, [{ action: 'report', reason: 'keepalive_silent' }]);

      const report = w.dog.report();
      assert.equal(report.mode, 'report');
      assert.equal(report.rebuilds, 0);
      assert.equal(report.lastRebuildAt, null);
      assert.equal(report.wouldRebuild, 1);
      assert.equal(report.lastReason, 'keepalive_silent');
      assert.equal(report.gaveUp, false);
    });

    it('a new episode after the triggers cleared is reported again', () => {
      const w = watchdog('report');

      w.run({ reasons: ['ws_closed'] }, 2 * 60_000);
      w.run({ reasons: [] }, WATCHDOG_CHECK_INTERVAL_MS);
      const decisions = w.run({ reasons: ['queue_stuck'] }, 2 * 60_000);

      assert.deepEqual(decisions, [{ action: 'report', reason: 'queue_stuck' }]);
      assert.equal(w.dog.report().wouldRebuild, 2);
    });
  });

  describe('report', () => {
    it('starts empty', () => {
      assert.deepEqual(watchdog('on').dog.report(), {
        mode: 'on',
        rebuilds: 0,
        lastRebuildAt: null,
        lastReason: null,
        wouldRebuild: 0,
        gaveUp: false,
      });
    });

    it('records the last rebuild', () => {
      const w = watchdog('on');
      const at = w.rebuild(['ws_closed']);

      const report = w.dog.report();
      assert.equal(report.rebuilds, 1);
      assert.equal(report.lastRebuildAt, new Date(at).toISOString());
      assert.equal(report.lastReason, 'ws_closed');
    });
  });

  describe('settings', () => {
    it('WATCHDOG_MODE', () => {
      assert.equal(DEFAULT_WATCHDOG_MODE, 'report');
      assert.equal(parseWatchdogMode('on'), 'on');
      assert.equal(parseWatchdogMode(' OFF '), 'off');
      assert.equal(parseWatchdogMode('report'), 'report');
      assert.equal(parseWatchdogMode(undefined), 'report');
      assert.equal(parseWatchdogMode('true'), 'report');
    });

    it('WATCHDOG_MAX_REBUILDS', () => {
      assert.equal(parseWatchdogMaxRebuilds('3'), 3);
      assert.equal(parseWatchdogMaxRebuilds(undefined), DEFAULT_WATCHDOG_MAX_REBUILDS);
      assert.equal(parseWatchdogMaxRebuilds('0'), DEFAULT_WATCHDOG_MAX_REBUILDS);
      assert.equal(parseWatchdogMaxRebuilds('-1'), DEFAULT_WATCHDOG_MAX_REBUILDS);
      assert.equal(parseWatchdogMaxRebuilds('many'), DEFAULT_WATCHDOG_MAX_REBUILDS);
    });
  });

  describe('with the health tracker', () => {
    const KEEP_ALIVE_MS = 30_000;

    /** The service's wiring: the tracker's stalled reasons feed the watchdog, on one clock. */
    function instance(mode: WatchdogMode = 'on') {
      const clock = { now: START };
      const health = new ConnectionHealth({ keepAliveIntervalMs: KEEP_ALIVE_MS, now: () => clock.now });
      const dog = new ConnectionWatchdog({ mode, maxRebuilds: DEFAULT_WATCHDOG_MAX_REBUILDS, now: () => clock.now });
      const live: LiveState = {
        state: 'open',
        wsOpen: true,
        attempt: 0,
        nextRetryAt: null,
        queueOldestAgeMs: 0,
        queueItemTimeoutMs: 120_000,
      };

      const tick = () => {
        clock.now += WATCHDOG_CHECK_INTERVAL_MS;
        return dog.check({ state: live.state, busy: false, reasons: health.stallReasons(live), queueProcessed: 0 });
      };

      return { clock, health, dog, live, tick };
    }

    it('a websocket closed under an open instance leads to one rebuild and then a healthy socket', () => {
      const i = instance();
      i.health.socketOpened();

      // The websocket closes and no close reaches the reconnect logic: the state still reads 'open'.
      i.live.wsOpen = false;
      const decisions: WatchdogDecision[] = [];

      for (let n = 0; n < 6; n++) {
        const decision = i.tick();
        if (decision.action !== 'none') decisions.push(decision);
        // Keep-alives still answered on the old socket's last frames do not matter: ws_closed is enough.
        i.health.frameReceived();
      }

      assert.deepEqual(decisions, [{ action: 'rebuild', reason: 'ws_closed', attempt: 1 }]);

      // The service rebuilds: a new socket, 'connecting', then 'open' with a live websocket.
      i.health.socketCreated();
      i.live.state = 'connecting';
      i.dog.rebuildFinished();
      assert.equal(i.tick().action, 'none');

      i.live.state = 'open';
      i.live.wsOpen = true;
      i.health.socketOpened();

      for (let n = 0; n < 60; n++) {
        i.health.frameReceived();
        assert.equal(i.tick().action, 'none');
      }

      assert.equal(i.dog.report().rebuilds, 1);
      assert.equal(i.dog.report().gaveUp, false);
    });

    it('a looping instance that reads open and is silent still triggers', () => {
      const i = instance();

      // Three opens that dropped on their own: the verdict is 'looping'.
      for (let n = 0; n < 3; n++) {
        i.health.socketOpened();
        i.health.socketClosed(428);
      }
      i.health.socketOpened();
      i.health.frameReceived();

      i.clock.now += 3 * KEEP_ALIVE_MS;
      assert.equal(i.health.report(i.live).verdict, 'looping');
      assert.deepEqual(i.health.stallReasons(i.live), ['keepalive_silent']);
    });

    it('unacked sends with a live socket never trigger', () => {
      const i = instance();
      i.health.socketOpened();
      i.health.sent('5511999999999@s.whatsapp.net', 'M1');

      // Between UNACKED_STALL_MS and the first keep-alive interval, the unacked send is the only stalled reason.
      for (let n = 0; n < 5; n++) {
        assert.equal(i.tick().action, 'none');
      }
      assert.deepEqual(i.health.stallReasons(i.live), ['sends_unacked']);

      // Keep-alives answered: the socket works, only the send has no ack.
      for (let n = 0; n < 30; n++) {
        i.health.frameReceived();
        assert.equal(i.tick().action, 'none');
      }

      assert.equal(i.health.report(i.live).outbound.unacked, 1);
    });
  });
});

describe('event queue progress (see #69)', () => {
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const queue = () =>
    new BaileysEventQueue({
      instanceId: 'test',
      logger,
      redis: null,
      prefix: 'test',
      itemTimeoutMs: 1_000,
      maxEntryBytes: 1024,
      maxLength: 10,
    });

  it('counts the items that left the queue', async () => {
    const q = queue();
    assert.equal(q.health().processed, 0);

    let release: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    q.enqueue(['messages.upsert'], () => held);
    q.enqueue(['messages.update'], async () => undefined);

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual({ pending: q.health().pending, processed: q.health().processed }, { pending: 2, processed: 0 });

    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual({ pending: q.health().pending, processed: q.health().processed }, { pending: 0, processed: 2 });
  });
});
