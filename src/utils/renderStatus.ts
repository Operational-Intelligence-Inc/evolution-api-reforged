import { wa } from '@api/types/wa.types';

export const status: Record<number, wa.StatusMessage> = {
  0: 'ERROR',
  1: 'PENDING',
  2: 'SERVER_ACK',
  3: 'DELIVERY_ACK',
  4: 'READ',
  5: 'PLAYED',
};

/**
 * The steps a sent message's status goes through, lowest first. ERROR sits right above PENDING: a refused send
 * replaces PENDING only, and a later ack replaces the ERROR.
 */
const SENT_STATUS_STEPS: wa.StatusMessage[] = ['PENDING', 'ERROR', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED'];

/**
 * The stored statuses that `next` may replace on a sent message (see #67). A status only moves up, so a receipt that
 * arrives late (a DELIVERY_ACK after the READ) cannot move it back. Empty when `next` is not one of the steps. A row
 * with no status at all may take any step; DELETED and EDITED rows keep theirs.
 */
export function sentStatusesBelow(next: string | null | undefined): wa.StatusMessage[] {
  const index = SENT_STATUS_STEPS.indexOf(next as wa.StatusMessage);
  return index === -1 ? [] : SENT_STATUS_STEPS.slice(0, index);
}

/** Whether a sent message whose stored status is `current` should take the status `next`. */
export function sentStatusAdvances(current: string | null | undefined, next: string | null | undefined): boolean {
  if (!SENT_STATUS_STEPS.includes(next as wa.StatusMessage)) {
    return false;
  }
  return !current || sentStatusesBelow(next).includes(current as wa.StatusMessage);
}
