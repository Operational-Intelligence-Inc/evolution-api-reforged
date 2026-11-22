import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sentStatusAdvances, sentStatusesBelow } from '../src/utils/renderStatus';

const RECEIPTS = ['PENDING', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED'];

describe('sentStatusAdvances', () => {
  it('moves up through the receipt steps, one or several at a time', () => {
    RECEIPTS.forEach((current, from) => {
      RECEIPTS.slice(from + 1).forEach((next) => assert.equal(sentStatusAdvances(current, next), true));
    });
  });

  it('never moves back or sideways', () => {
    RECEIPTS.forEach((current, from) => {
      RECEIPTS.slice(0, from + 1).forEach((next) => assert.equal(sentStatusAdvances(current, next), false));
    });
  });

  it('gives a row without a status any step', () => {
    for (const next of [...RECEIPTS, 'ERROR']) {
      assert.equal(sentStatusAdvances(null, next), true);
      assert.equal(sentStatusAdvances(undefined, next), true);
    }
  });

  it('records a refused send only while the message is still pending', () => {
    assert.equal(sentStatusAdvances('PENDING', 'ERROR'), true);
    for (const current of ['SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED']) {
      assert.equal(sentStatusAdvances(current, 'ERROR'), false);
    }
  });

  it('lets a later ack replace an error, but not PENDING', () => {
    for (const next of ['SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED']) {
      assert.equal(sentStatusAdvances('ERROR', next), true);
    }
    assert.equal(sentStatusAdvances('ERROR', 'PENDING'), false);
  });

  it('leaves deleted and edited rows alone', () => {
    for (const current of ['DELETED', 'EDITED']) {
      assert.equal(sentStatusAdvances(current, 'READ'), false);
    }
  });

  it('ignores a status that is not a receipt step', () => {
    for (const next of [undefined, null, '', 'DELETED', 'EDITED']) {
      assert.equal(sentStatusAdvances('PENDING', next), false);
      assert.equal(sentStatusAdvances(null, next), false);
    }
  });
});

describe('sentStatusesBelow', () => {
  it('lists the stored statuses a receipt may replace', () => {
    assert.deepEqual(sentStatusesBelow('PENDING'), []);
    assert.deepEqual(sentStatusesBelow('ERROR'), ['PENDING']);
    assert.deepEqual(sentStatusesBelow('SERVER_ACK'), ['PENDING', 'ERROR']);
    assert.deepEqual(sentStatusesBelow('READ'), ['PENDING', 'ERROR', 'SERVER_ACK', 'DELIVERY_ACK']);
  });

  it('is empty for a status that is not a receipt step', () => {
    assert.deepEqual(sentStatusesBelow('DELETED'), []);
    assert.deepEqual(sentStatusesBelow(undefined), []);
  });
});
