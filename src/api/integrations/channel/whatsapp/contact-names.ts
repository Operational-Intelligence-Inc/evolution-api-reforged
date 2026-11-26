/**
 * Which name a "Contact" row gets, and when a later name may replace it.
 *
 * WhatsApp gives a contact up to three names, in order of precedence:
 *   1. `name`: the account's own address-book name for the contact;
 *   2. `notify`: the push name the person chose (e.g. "~ Ana");
 *   3. `verifiedName`: a business account's verified name.
 * With none of them, a new row is named by the digits of its JID. That fallback is written only on insert and never
 * replaces anything.
 *
 * "Contact" keeps one `pushName` column and does not record where its value came from, so an address-book name can't be
 * told from an older push name. The safe rule: an address-book name replaces any name; a push name or business name
 * replaces only a placeholder (no name, or the JID's digits). The cost is that a push name the person changes later
 * doesn't replace the earlier one.
 */

/** `Contact.pushName` is VARCHAR(100). */
export const CONTACT_NAME_MAX = 100;

export type ContactNameSource = 'name' | 'notify' | 'verifiedName';

export interface ContactNames {
  id?: string;
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
}

export interface PickedContactName {
  name: string;
  source: ContactNameSource;
}

/**
 * Makes a name from WhatsApp safe to store: drops NUL characters (Postgres refuses them), trims, and cuts to the
 * column's length by code point, so a surrogate pair is never split. Returns undefined when nothing is left.
 */
export function cleanContactName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = Array.from(value.replace(/\u0000/g, '').trim())
    .slice(0, CONTACT_NAME_MAX)
    .join('')
    .trim();
  return cleaned || undefined;
}

/** The JID's local part, the digits a nameless row is stored with. */
export function fallbackContactName(jid: string): string {
  return jid.split('@')[0];
}

/** True for a stored name that is not a real name: empty, digits only, or the JID's local part. */
export function isPlaceholderContactName(pushName: string | null | undefined, jid?: string): boolean {
  const name = pushName?.trim();
  if (!name) return true;
  if (/^\d+$/.test(name)) return true;
  return !!jid && name === fallbackContactName(jid);
}

/** The best real name the contact carries, by precedence, or undefined when it carries none. */
export function pickContactName(contact: ContactNames): PickedContactName | undefined {
  for (const source of ['name', 'notify', 'verifiedName'] as const) {
    const name = cleanContactName(contact[source]);
    if (name && !isPlaceholderContactName(name, contact.id)) return { name, source };
  }
  return undefined;
}

/** Whether `incoming` should replace the name a row already has. */
export function shouldReplaceContactName(
  existing: string | null | undefined,
  incoming: PickedContactName | undefined,
  jid?: string,
): boolean {
  if (!incoming || existing === incoming.name) return false;
  if (incoming.source === 'name') return true;
  return isPlaceholderContactName(existing, jid);
}

/**
 * Collapses a batch to one name per JID, keeping the highest-precedence one (the later one on a tie), so a batch that
 * names a contact twice can't write both.
 */
export function bestNamesByJid(contacts: ContactNames[]): Map<string, PickedContactName> {
  const rank: Record<ContactNameSource, number> = { name: 0, notify: 1, verifiedName: 2 };
  const best = new Map<string, PickedContactName>();
  for (const contact of contacts) {
    if (!contact.id) continue;
    const picked = pickContactName(contact);
    if (!picked) continue;
    const current = best.get(contact.id);
    if (!current || rank[picked.source] <= rank[current.source]) best.set(contact.id, picked);
  }
  return best;
}
