import assert from 'node:assert/strict';
import test from 'node:test';

import { renderMessage } from '../src/message-template.js';

test('renders outbound message placeholders, using only the first word of the display name', () => {
  assert.equal(
    renderMessage('Hey {name}, saw @{handle}: {profile_url}', {
      handle: 'creator',
      display_name: 'Creator Name',
      profile_url: 'https://www.instagram.com/creator/',
    }),
    'Hey Creator, saw @creator: https://www.instagram.com/creator/',
  );
});

test('falls back to @handle when display name is missing', () => {
  assert.equal(
    renderMessage('Hey {name}', {
      handle: 'creator',
    }),
    'Hey @creator',
  );
});

test('falls back to "there" when neither display name nor handle exists', () => {
  assert.equal(renderMessage('Hey {name}', {}), 'Hey there');
});
