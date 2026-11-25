import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { unwrapMessageContent } from '../src/api/integrations/channel/whatsapp/media-message';

const image = { imageMessage: { mimetype: 'image/jpeg', directPath: '/v/t62/abc' }, messageContextInfo: {} };

describe('unwrapMessageContent', () => {
  it('unwraps an album item (associatedChildMessage) (#91)', () => {
    assert.deepEqual(unwrapMessageContent({ associatedChildMessage: { message: image } }), image);
  });

  it('still unwraps disappearing, view-once and document-with-caption messages', () => {
    for (const wrapper of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
      assert.deepEqual(unwrapMessageContent({ [wrapper]: { message: image } }), image, wrapper);
    }
  });

  it('unwraps nested wrappers in either order', () => {
    assert.deepEqual(
      unwrapMessageContent({ ephemeralMessage: { message: { associatedChildMessage: { message: image } } } }),
      image,
    );
    assert.deepEqual(
      unwrapMessageContent({ associatedChildMessage: { message: { viewOnceMessageV2: { message: image } } } }),
      image,
    );
  });

  it('leaves unwrapped messages and wrappers with no inner message as they are', () => {
    assert.equal(unwrapMessageContent(image), image);
    const empty = { associatedChildMessage: {} };
    assert.equal(unwrapMessageContent(empty), empty);
  });

  it('stops on a cyclic payload', () => {
    const cyclic: any = { ephemeralMessage: {} };
    cyclic.ephemeralMessage.message = cyclic;
    assert.equal(unwrapMessageContent(cyclic), cyclic);
  });
});
