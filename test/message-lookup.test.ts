import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  alternateChatQuery,
  chatJidsOf,
  fromMeOf,
  fullKeyQuery,
  hasChat,
  idOnlyQuery,
} from '../src/api/integrations/channel/whatsapp/message-lookup';

/** Collapses whitespace so assertions don't depend on the template's indentation. */
const text = (sql: { text: string }) => sql.text.replace(/\s+/g, ' ').trim();

describe('fromMeOf', () => {
  it('counts only true, or "true" from a JSON body, as sent', () => {
    assert.equal(fromMeOf({ fromMe: true }), true);
    assert.equal(fromMeOf({ fromMe: 'true' as any }), true);
    assert.equal(fromMeOf({ fromMe: false }), false);
    assert.equal(fromMeOf({ fromMe: 'false' as any }), false);
    assert.equal(fromMeOf({ fromMe: null }), false);
    assert.equal(fromMeOf({}), false);
  });
});

describe('chatJidsOf', () => {
  it('returns the remoteJid and its LID/PN alternate', () => {
    assert.deepEqual(chatJidsOf({ remoteJid: '123@lid', remoteJidAlt: '5511999999999@s.whatsapp.net' }), [
      '123@lid',
      '5511999999999@s.whatsapp.net',
    ]);
  });

  it('drops the device suffix and duplicates', () => {
    assert.deepEqual(
      chatJidsOf({ remoteJid: '5511999999999:12@s.whatsapp.net', remoteJidAlt: '5511999999999@s.whatsapp.net' }),
      ['5511999999999@s.whatsapp.net'],
    );
  });

  it('keeps group JIDs as they are', () => {
    assert.deepEqual(chatJidsOf({ remoteJid: '120363000000000000@g.us' }), ['120363000000000000@g.us']);
  });

  it('ignores a missing, empty or non-string remoteJid', () => {
    assert.deepEqual(chatJidsOf({}), []);
    assert.deepEqual(chatJidsOf({ remoteJid: '' }), []);
    assert.deepEqual(chatJidsOf({ remoteJid: 42 as any }), []);
    assert.equal(hasChat({ id: 'ABC' }), false);
    assert.equal(hasChat({ id: 'ABC', remoteJid: '5511999999999@s.whatsapp.net' }), true);
  });
});

describe('fullKeyQuery', () => {
  const key = { remoteJid: '5511999999999@s.whatsapp.net', id: 'ABC', fromMe: false };

  it('repeats the unique index expressions so the lookup is served by Message_instanceId_key_unique', () => {
    const sql = text(fullKeyQuery('inst-1', key));

    assert.match(sql, /"instanceId" = \$1/);
    assert.match(sql, /"key"->>'remoteJid' = ANY\(\$2::text\[\]\)/);
    assert.match(sql, /"key"->>'id' = \$3/);
    assert.match(sql, /\("key"->>'fromMe'\)::boolean = \$4/);
    assert.doesNotMatch(sql, /COALESCE|remoteJidAlt/);
    assert.match(sql, /ORDER BY "messageTimestamp" DESC, "id" DESC LIMIT 1$/);
  });

  it('binds the chat, id and direction as parameters', () => {
    assert.deepEqual(fullKeyQuery('inst-1', key).values, ['inst-1', ['5511999999999@s.whatsapp.net'], 'ABC', false]);
    assert.deepEqual(fullKeyQuery('inst-1', { ...key, fromMe: true }).values.at(-1), true);
    assert.deepEqual(fullKeyQuery('inst-1', { remoteJid: key.remoteJid, id: 'ABC' }).values.at(-1), false);
  });
});

describe('alternateChatQuery', () => {
  it('stays within the chat, matching its JIDs against remoteJid or remoteJidAlt', () => {
    const query = alternateChatQuery('inst-1', { remoteJid: '5511999999999@s.whatsapp.net', id: 'ABC', fromMe: true });
    const sql = text(query);

    assert.match(sql, /"key"->>'id' = \$2/);
    assert.match(sql, /COALESCE\(\("key"->>'fromMe'\)::boolean, false\) = \$3/);
    assert.match(sql, /"key"->>'remoteJid' = ANY\(\$4::text\[\]\) OR "key"->>'remoteJidAlt' = ANY\(\$5::text\[\]\)/);
    assert.match(sql, /LIMIT 1$/);
    assert.deepEqual(query.values, [
      'inst-1',
      'ABC',
      true,
      ['5511999999999@s.whatsapp.net'],
      ['5511999999999@s.whatsapp.net'],
    ]);
  });
});

describe('idOnlyQuery', () => {
  it('is ordered and limited, so a shared id returns the same row every time', () => {
    const query = idOnlyQuery('inst-1', 'ABC');

    assert.match(text(query), /ORDER BY "messageTimestamp" DESC, "id" DESC LIMIT 1$/);
    assert.deepEqual(query.values, ['inst-1', 'ABC']);
  });
});
