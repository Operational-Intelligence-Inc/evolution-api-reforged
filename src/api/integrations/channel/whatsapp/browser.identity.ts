/**
 * Which browser identity a Baileys socket advertises to WhatsApp (see #64).
 *
 * Baileys recommends a Desktop identity for full history: it advertises a Desktop web sub-platform only when
 * `syncFullHistory` is on and the browser tuple is `['Windows' | 'Mac OS', 'Desktop', ...]`. In a live test the identity
 * alone did not lengthen the import; the history window comes from `historySyncConfig.fullSyncDaysLimit`, which the
 * same patch sets (see #65). Baileys rc14 maps Windows to WIN32, which WhatsApp has rejected with 428
 * before the QR since about 2026-06-30, so the dependency is patched to WIN_HYBRID (patches/baileys+*.patch,
 * WhiskeySockets/Baileys#2741). 'Mac OS' (DARWIN) still gets 428 and is never used.
 *
 * The identity is chosen once, when the device is paired, and kept for the life of the session: the sub-platform is
 * sent again on every login, and a session paired as one device type must not log in as another. A session paired
 * with the Desktop identity is marked in its creds (CREDS_IDENTITY_KEY). Sessions paired before this change carry no
 * marker and keep the configured browser identity.
 *
 * Kept free of Baileys imports so its unit tests don't load Baileys.
 */

export type BrowserTuple = [string, string, string];

/** Field added to the Baileys creds object (persisted with it) to remember a Desktop-identity pairing. */
export const CREDS_IDENTITY_KEY = 'evolutionBrowserIdentity';
export const DESKTOP_IDENTITY = 'desktop';

/** What Baileys' Browsers.windows('Desktop') advertises. Shown on the phone under Linked Devices as Windows. */
export const DESKTOP_BROWSER: BrowserTuple = ['Windows', 'Desktop', '10.0.22631'];

export interface BrowserIdentityInput {
  /** The creds already belong to a linked device (creds.me is set). */
  paired: boolean;
  /** creds[CREDS_IDENTITY_KEY], if any. */
  storedIdentity?: unknown;
  /** The instance's syncFullHistory setting. */
  syncFullHistory: boolean;
  /** Pairing (or paired) by phone-number code rather than QR. */
  pairingCode: boolean;
  /** CONFIG_SESSION_PHONE_CLIENT / CONFIG_SESSION_PHONE_NAME. */
  configuredClient: string;
  configuredName: string;
  /** os.release(), the third element of the configured browser tuple. */
  osRelease: string;
}

export interface BrowserIdentity {
  /** Browser tuple to pass to Baileys; undefined leaves Baileys' default (the existing pairing-code behaviour). */
  browser?: BrowserTuple;
  /** The Desktop identity is in use: the session must be (or is being) marked with DESKTOP_IDENTITY. */
  desktop: boolean;
  /**
   * Value for Baileys' own `syncFullHistory` option. Baileys reads it only to build the client payload, so a Desktop
   * session always passes true: otherwise it would log in as WEB_BROWSER once the setting is turned off. Evolution's
   * own history filtering keeps following the instance setting.
   */
  baileysSyncFullHistory: boolean;
}

export function chooseBrowserIdentity(input: BrowserIdentityInput): BrowserIdentity {
  const desktop = input.paired ? input.storedIdentity === DESKTOP_IDENTITY : input.syncFullHistory === true;

  if (desktop) {
    return { browser: [...DESKTOP_BROWSER], desktop: true, baileysSyncFullHistory: true };
  }

  return {
    browser: input.pairingCode ? undefined : [input.configuredClient, input.configuredName, input.osRelease],
    desktop: false,
    baileysSyncFullHistory: input.syncFullHistory === true,
  };
}
