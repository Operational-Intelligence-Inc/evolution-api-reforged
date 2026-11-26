import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bestNamesByJid,
  cleanContactName,
  CONTACT_NAME_MAX,
  fallbackContactName,
  isPlaceholderContactName,
  pickContactName,
  shouldReplaceContactName,
} from '../src/api/integrations/channel/whatsapp/contact-names';

const LID = '123456789012345@lid';

describe('cleanContactName', () => {
  it('drops NUL characters and trims', () => {
    assert.equal(cleanContactName('  An\u0000a '), 'Ana');
  });

  it('returns undefined for empty or non-string values', () => {
    assert.equal(cleanContactName(''), undefined);
    assert.equal(cleanContactName(' \u0000 '), undefined);
    assert.equal(cleanContactName(undefined), undefined);
    assert.equal(cleanContactName(null), undefined);
    assert.equal(cleanContactName(42), undefined);
  });

  it('cuts to the column length by code point, never splitting a surrogate pair', () => {
    const long = '😀'.repeat(CONTACT_NAME_MAX + 5);
    const cleaned = cleanContactName(long);
    assert.equal(Array.from(cleaned).length, CONTACT_NAME_MAX);
    assert.equal(cleaned, '😀'.repeat(CONTACT_NAME_MAX));
  });
});

describe('isPlaceholderContactName', () => {
  it('treats no name, digits, and the JID local part as placeholders', () => {
    assert.equal(isPlaceholderContactName(null), true);
    assert.equal(isPlaceholderContactName(''), true);
    assert.equal(isPlaceholderContactName('123456789012345'), true);
    assert.equal(isPlaceholderContactName('5511999-1600000000', '5511999-1600000000@g.us'), true);
  });

  it('keeps real names', () => {
    assert.equal(isPlaceholderContactName('~ Ana', LID), false);
    assert.equal(isPlaceholderContactName('Ana 2', LID), false);
  });
});

describe('pickContactName', () => {
  it('prefers address-book name, then push name, then business name', () => {
    assert.deepEqual(pickContactName({ id: LID, name: 'Ana Silva', notify: '~ Ana', verifiedName: 'Ana Co' }), {
      name: 'Ana Silva',
      source: 'name',
    });
    assert.deepEqual(pickContactName({ id: LID, notify: '~ Ana', verifiedName: 'Ana Co' }), {
      name: '~ Ana',
      source: 'notify',
    });
    assert.deepEqual(pickContactName({ id: LID, verifiedName: 'Ana Co' }), { name: 'Ana Co', source: 'verifiedName' });
  });

  it('skips names that are only digits', () => {
    assert.deepEqual(pickContactName({ id: LID, name: '123456789012345', notify: '~ Ana' }), {
      name: '~ Ana',
      source: 'notify',
    });
    assert.equal(pickContactName({ id: LID, notify: '5511999999999' }), undefined);
    assert.equal(pickContactName({ id: LID }), undefined);
  });
});

describe('shouldReplaceContactName', () => {
  const pushName = { name: '~ Ana', source: 'notify' as const };
  const bookName = { name: 'Ana Silva', source: 'name' as const };

  it('lets a push name replace only a placeholder', () => {
    assert.equal(shouldReplaceContactName(null, pushName, LID), true);
    assert.equal(shouldReplaceContactName(fallbackContactName(LID), pushName, LID), true);
    assert.equal(shouldReplaceContactName('Ana Silva', pushName, LID), false);
    assert.equal(shouldReplaceContactName('~ Old', pushName, LID), false);
  });

  it('lets an address-book name replace any other name', () => {
    assert.equal(shouldReplaceContactName('~ Ana', bookName, LID), true);
    assert.equal(shouldReplaceContactName(fallbackContactName(LID), bookName, LID), true);
  });

  it('does nothing without a name, or when the name is unchanged', () => {
    assert.equal(shouldReplaceContactName(null, undefined, LID), false);
    assert.equal(shouldReplaceContactName('Ana Silva', bookName, LID), false);
  });
});

describe('bestNamesByJid', () => {
  it('keeps the highest-precedence name per JID and skips nameless contacts', () => {
    const names = bestNamesByJid([
      { id: LID, name: 'Ana Silva' },
      { id: LID, notify: '~ Ana' },
      { id: 'b@lid', notify: '~ Bia' },
      { id: 'c@lid' },
    ]);
    assert.deepEqual(Object.fromEntries(names), {
      [LID]: { name: 'Ana Silva', source: 'name' },
      'b@lid': { name: '~ Bia', source: 'notify' },
    });
  });
});
