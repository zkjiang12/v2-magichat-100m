import assert from 'node:assert/strict';
import test from 'node:test';

import { collectCreatorEmails, extractEmailsFromText, normalizeEmail } from '../src/contacts.js';

test('extracts a plain email from bio text', () => {
  assert.deepEqual(
    extractEmailsFromText('UGC creator 🌸 brand deals: sarah.k@gmail.com ⬇️'),
    ['sarah.k@gmail.com'],
  );
});

test('extracts multiple emails and dedupes', () => {
  assert.deepEqual(
    extractEmailsFromText('biz: a@b.com / personal: c@d.co / again a@b.com'),
    ['a@b.com', 'c@d.co'],
  );
});

test('lowercases emails', () => {
  assert.deepEqual(extractEmailsFromText('Contact: Sarah.K@Gmail.COM'), ['sarah.k@gmail.com']);
});

test('ignores instagram @mentions', () => {
  assert.deepEqual(extractEmailsFromText('collab w/ @bestie and @brand.us love them'), []);
});

test('ignores image filenames that look like emails', () => {
  assert.deepEqual(extractEmailsFromText('see logo@2x.png for details'), []);
});

test('handles trailing punctuation', () => {
  assert.deepEqual(extractEmailsFromText('email me: foo@bar.com!'), ['foo@bar.com']);
});

test('handles emails followed by a period at sentence end', () => {
  assert.deepEqual(extractEmailsFromText('Reach me at foo@bar.com.'), ['foo@bar.com']);
});

test('returns empty for null, undefined, and email-free text', () => {
  assert.deepEqual(extractEmailsFromText(null), []);
  assert.deepEqual(extractEmailsFromText(undefined), []);
  assert.deepEqual(extractEmailsFromText('just a normal bio about hiking'), []);
});

test('collectCreatorEmails puts the business contact email first and dedupes against bio', () => {
  assert.deepEqual(
    collectCreatorEmails({
      bio: 'inquiries: studio@brand.com or me@me.com',
      publicEmail: 'me@me.com',
    }),
    ['me@me.com', 'studio@brand.com'],
  );
});

test('collectCreatorEmails works when only one source is present', () => {
  assert.deepEqual(collectCreatorEmails({ bio: 'hi: a@b.com' }), ['a@b.com']);
  assert.deepEqual(collectCreatorEmails({ publicEmail: 'a@b.com' }), ['a@b.com']);
  assert.deepEqual(collectCreatorEmails({}), []);
  assert.deepEqual(collectCreatorEmails(), []);
});

test('normalizeEmail rejects junk and over-long values', () => {
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail(`${'a'.repeat(300)}@b.com`), null);
  assert.equal(normalizeEmail('  Foo@Bar.com  '), 'foo@bar.com');
});
