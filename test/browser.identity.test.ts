import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BrowserIdentityInput,
  chooseBrowserIdentity,
  DESKTOP_BROWSER,
  DESKTOP_IDENTITY,
} from '../src/api/integrations/channel/whatsapp/browser.identity';

/** A fresh QR pairing with the default configured identity and full history off. */
function input(overrides: Partial<BrowserIdentityInput> = {}): BrowserIdentityInput {
  return {
    paired: false,
    storedIdentity: undefined,
    syncFullHistory: false,
    pairingCode: false,
    configuredClient: 'Evolution API',
    configuredName: 'Chrome',
    osRelease: '6.8.0',
    ...overrides,
  };
}

describe('chooseBrowserIdentity', () => {
  it('keeps the configured browser identity when full history is off', () => {
    assert.deepEqual(chooseBrowserIdentity(input()), {
      browser: ['Evolution API', 'Chrome', '6.8.0'],
      desktop: false,
      baileysSyncFullHistory: false,
    });
  });

  it('pairs a full-history instance with the Windows Desktop identity', () => {
    assert.deepEqual(chooseBrowserIdentity(input({ syncFullHistory: true })), {
      browser: DESKTOP_BROWSER,
      desktop: true,
      baileysSyncFullHistory: true,
    });
  });

  it('uses the Desktop identity for a full-history pairing by code too', () => {
    const identity = chooseBrowserIdentity(input({ syncFullHistory: true, pairingCode: true }));
    assert.deepEqual(identity.browser, DESKTOP_BROWSER);
    assert.equal(identity.desktop, true);
  });

  it('leaves Baileys its default browser for a pairing by code without full history', () => {
    const identity = chooseBrowserIdentity(input({ pairingCode: true }));
    assert.equal(identity.browser, undefined);
    assert.equal(identity.desktop, false);
  });

  it('keeps a session paired before the change on the configured identity, even with full history on', () => {
    assert.deepEqual(chooseBrowserIdentity(input({ paired: true, syncFullHistory: true })), {
      browser: ['Evolution API', 'Chrome', '6.8.0'],
      desktop: false,
      baileysSyncFullHistory: true,
    });
  });

  it('keeps a Desktop-paired session on the Desktop identity after full history is turned off', () => {
    assert.deepEqual(
      chooseBrowserIdentity(input({ paired: true, storedIdentity: DESKTOP_IDENTITY, syncFullHistory: false })),
      { browser: DESKTOP_BROWSER, desktop: true, baileysSyncFullHistory: true },
    );
  });

  it('returns a copy of the Desktop tuple', () => {
    const identity = chooseBrowserIdentity(input({ syncFullHistory: true }));
    assert.notEqual(identity.browser, DESKTOP_BROWSER);
  });
});

describe('patched Baileys client payload', () => {
  // generateLoginNode is what every login of a linked device sends; it carries the web sub-platform.
  const loginPayload = async (browser: [string, string, string], syncFullHistory: boolean) => {
    const { generateLoginNode, proto } = await import('baileys');
    const payload = generateLoginNode('5511999999999:3@s.whatsapp.net', {
      browser,
      syncFullHistory,
      version: [2, 3000, 0],
      countryCode: 'US',
    } as any);
    return {
      webSubPlatform: payload.webInfo?.webSubPlatform,
      WebSubPlatform: proto.ClientPayload.WebInfo.WebSubPlatform,
    };
  };

  it('advertises WIN_HYBRID, not WIN32, for the Windows Desktop identity (WhiskeySockets/Baileys#2741)', async () => {
    const { webSubPlatform, WebSubPlatform } = await loginPayload(DESKTOP_BROWSER, true);
    assert.equal(webSubPlatform, WebSubPlatform.WIN_HYBRID);
  });

  it('advertises WEB_BROWSER for the default identity', async () => {
    const { webSubPlatform, WebSubPlatform } = await loginPayload(['Evolution API', 'Chrome', '6.8.0'], true);
    assert.equal(webSubPlatform, WebSubPlatform.WEB_BROWSER);
  });
});

describe('patched Baileys registration payload', () => {
  // generateRegistrationNode is what a QR pairing sends; its DeviceProps carry the history sync request.
  const historySyncConfig = async (syncFullHistory: boolean) => {
    const { generateRegistrationNode, proto } = await import('baileys');
    const key = { public: Buffer.alloc(32), private: Buffer.alloc(32) };
    const payload = generateRegistrationNode(
      { registrationId: 1, signedPreKey: { keyId: 1, keyPair: key, signature: Buffer.alloc(64) }, signedIdentityKey: key } as any,
      { browser: ['Windows', 'Desktop', '10.0.22631'], syncFullHistory, version: [2, 3000, 0], countryCode: 'US' } as any,
    );
    return proto.DeviceProps.decode(payload.devicePairingData!.deviceProps!).historySyncConfig!;
  };

  it('asks for ten years of history when full history is on', async () => {
    assert.equal((await historySyncConfig(true)).fullSyncDaysLimit, 3650);
  });

  it('leaves the history window to WhatsApp when full history is off', async () => {
    assert.equal((await historySyncConfig(false)).fullSyncDaysLimit ?? undefined, undefined);
  });
});
