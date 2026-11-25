// From the Prisma runtime rather than the generated client (Prisma.sql is the same function), so this module and
// its unit tests load before `prisma generate` has run.
import { Sql, sqltag } from '@prisma/client/runtime/library';
import type { proto } from 'baileys';

/**
 * Finding a stored message by its key (#86).
 *
 * A WhatsApp message id is unique only within one chat and one direction, so a lookup by id alone can return a
 * message from another chat. Callers that know which chat they mean use the full key: remoteJid, id and fromMe.
 */

export type MessageKeyLike = proto.IMessageKey & { remoteJidAlt?: string | null };

/**
 * Same result as Baileys' jidNormalizedUser (drops agent and device, maps c.us to s.whatsapp.net), kept local so
 * this module loads without the Baileys runtime.
 */
function normalizeJid(jid: string): string {
  const at = jid.indexOf('@');
  if (at < 0) {
    return jid;
  }
  const user = jid.slice(0, at).split(':')[0].split('_')[0];
  const server = jid.slice(at + 1);
  return `${user}@${server === 'c.us' ? 's.whatsapp.net' : server}`;
}

/** A key's direction. Only `true` (or `"true"` from an unvalidated JSON body) counts as sent; missing means received. */
export function fromMeOf(key: MessageKeyLike): boolean {
  const fromMe = key?.fromMe as unknown;
  return fromMe === true || fromMe === 'true';
}

/**
 * The JIDs one chat can be stored under: the key's remoteJid and its LID/PN alternate, without device suffix.
 * A message received from a LID chat is stored with the LID as remoteJid and the phone-number JID as remoteJidAlt,
 * but the webhook reports the phone-number JID, so either may come back to us.
 */
export function chatJidsOf(key: MessageKeyLike): string[] {
  const jids = [key?.remoteJid, key?.remoteJidAlt]
    .filter((jid): jid is string => typeof jid === 'string' && jid.length > 0)
    .map(normalizeJid);
  return [...new Set(jids)];
}

/** Whether a key names its chat, so the full-key lookup applies. */
export function hasChat(key: MessageKeyLike): boolean {
  return chatJidsOf(key).length > 0;
}

/**
 * The exact full-key lookup. Its WHERE clause repeats the expressions of the unique index
 * "Message_instanceId_key_unique" ("instanceId", key->>'remoteJid', key->>'id', (key->>'fromMe')::boolean),
 * so it is an index lookup. Keep the expressions as they are or the index stops applying.
 */
export function fullKeyQuery(instanceId: string, key: MessageKeyLike): Sql {
  return sqltag`
    SELECT * FROM "Message"
    WHERE "instanceId" = ${instanceId}
    AND "key"->>'remoteJid' = ANY(${chatJidsOf(key)}::text[])
    AND "key"->>'id' = ${key.id}
    AND ("key"->>'fromMe')::boolean = ${fromMeOf(key)}
    ORDER BY "messageTimestamp" DESC, "id" DESC
    LIMIT 1
  `;
}

/**
 * The fallback when the exact lookup misses: the caller's JID may be the stored row's remoteJidAlt (a LID chat
 * reported by its phone number), or the row may lack fromMe. Still limited to the same chat and direction.
 * Not served by the unique index, so it runs only after fullKeyQuery found nothing.
 */
export function alternateChatQuery(instanceId: string, key: MessageKeyLike): Sql {
  const jids = chatJidsOf(key);
  return sqltag`
    SELECT * FROM "Message"
    WHERE "instanceId" = ${instanceId}
    AND "key"->>'id' = ${key.id}
    AND COALESCE(("key"->>'fromMe')::boolean, false) = ${fromMeOf(key)}
    AND ("key"->>'remoteJid' = ANY(${jids}::text[]) OR "key"->>'remoteJidAlt' = ANY(${jids}::text[]))
    ORDER BY "messageTimestamp" DESC, "id" DESC
    LIMIT 1
  `;
}

/**
 * Lookup by id alone, for callers with no chat to go on (Baileys' getMessage callback, which may pass the PN JID
 * for a row stored under the LID). Ordered so that when an id is shared by several chats it returns the same row
 * every time.
 */
export function idOnlyQuery(instanceId: string, id: string): Sql {
  return sqltag`
    SELECT * FROM "Message"
    WHERE "instanceId" = ${instanceId}
    AND "key"->>'id' = ${id}
    ORDER BY "messageTimestamp" DESC, "id" DESC
    LIMIT 1
  `;
}
