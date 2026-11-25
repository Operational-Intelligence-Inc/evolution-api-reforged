import { MessageSubtype } from '@api/types/wa.types';

/** More than any real message nests; only guards against a malformed or cyclic payload. */
const MAX_UNWRAP_DEPTH = 5;

/**
 * Returns the content inside the wrappers listed in `MessageSubtype` (disappearing, view-once, document with
 * caption, album item). Wrappers can nest in any order, e.g. an album item in a disappearing chat, so it unwraps
 * until none is left. A wrapper with no inner message is kept as it is.
 */
export function unwrapMessageContent<T extends Record<string, any>>(message: T): T {
  let content: any = message;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const subtype = MessageSubtype.find((s) => content?.[s]?.message);
    if (!subtype) break;
    content = content[subtype].message;
  }
  return content;
}
