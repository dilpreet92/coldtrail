// Pure parts of the app shell (ui/js/shell.js). Its DOM behaviour is covered in the browser by
// tests/e2e/specs/shell.spec.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchDrafts, draftOption, draftHref, companyHref } from '../../ui/js/shell.js';

const DRAFTS = [
  { domain: 'northwind-health.example', channel: 'linkedin', to: 'https://www.linkedin.com/in/sami-roe-1', contact_name: 'Sami Roe', company_name: 'Northwind Health', subject: null },
  { domain: 'acme.example', channel: 'email', to: 'kenji@acme.example', contact_name: 'Kenji Hassan', company_name: 'Acme', subject: 'Quick question' },
  { domain: 'bare.example', channel: 'email', to: 'hi@bare.example', contact_name: null, company_name: null, subject: 'Hello' },
];

test('matchDrafts finds a draft by the contact and company the Drafts list names it by', () => {
  const domains = (q) => matchDrafts(DRAFTS, q).map((d) => d.domain);
  assert.deepEqual(domains('Sami Roe'), ['northwind-health.example']);
  assert.deepEqual(domains('kenji hassan'), ['acme.example'], 'any case');
  assert.deepEqual(domains('Northwind Health'), ['northwind-health.example']);
  assert.deepEqual(domains('  acme '), ['acme.example'], 'company, domain and recipient; trimmed');
  assert.deepEqual(domains('hello'), ['bare.example'], 'the subject still counts');
  assert.deepEqual(domains('nobody'), []);
  assert.equal(matchDrafts(DRAFTS, 'example', 2).length, 2, 'at most `limit`');
});

test('draftOption names a draft as the Drafts list does: contact · company, then channel and domain', () => {
  assert.deepEqual(draftOption(DRAFTS[0]), { name: 'Sami Roe · Northwind Health', meta: 'LinkedIn note · northwind-health.example' });
  assert.deepEqual(draftOption(DRAFTS[1]), { name: 'Kenji Hassan · Acme', meta: 'Email · acme.example · Quick question' });
  // Without a contact: an email's recipient, and the domain once.
  assert.deepEqual(draftOption(DRAFTS[2]), { name: 'hi@bare.example', meta: 'Email · bare.example · Hello' });
  assert.deepEqual(draftOption({ domain: 'x.example', channel: 'email', company_name: 'X Co', subject: '' }), { name: 'X Co', meta: 'Email · x.example' });
  assert.deepEqual(draftOption({ domain: 'y.example', channel: 'linkedin', contact_name: ' ', to: 'https://linkedin.com/in/y' }), { name: 'y.example', meta: 'LinkedIn note' });
  assert.deepEqual(draftOption({ domain: 'z.example', channel: 'linkedin', contact_name: 'Zed' }), { name: 'Zed', meta: 'LinkedIn note · z.example' });
});

test('a draft result opens its own channel when the company has drafts on both', () => {
  const email = { domain: 'xenia.example', channel: 'email', contact_name: 'Maya Moreau', company_name: 'Xenia', subject: 'Quick idea' };
  const note = { domain: 'xenia.example', channel: 'linkedin', contact_name: 'Lina Note', company_name: 'Xenia' };
  const all = [note, email, ...DRAFTS];
  assert.equal(draftHref(email, all), '#/drafts/xenia.example?channel=email');
  assert.equal(draftHref(note, all), '#/drafts/xenia.example?channel=linkedin');
  // One channel only: the plain address, as Drafts writes it.
  assert.equal(draftHref(DRAFTS[1], all), '#/drafts/acme.example');
  assert.equal(draftHref(DRAFTS[0], all), '#/drafts/northwind-health.example');
  assert.equal(draftHref({ domain: 'y.example' }, [{ domain: 'y.example', channel: 'linkedin' }]), '#/drafts/y.example?channel=email', 'no channel is email');
});

test('matchDrafts folds drafts on the same domain and channel, as the Drafts list does', () => {
  const rows = [
    { domain: 'xenia.example', channel: 'email', contact_name: 'Maya Moreau', company_name: 'Xenia' },
    { domain: 'xenia.example', channel: 'email', contact_name: 'Old Draft', company_name: 'Xenia' },
    { domain: 'xenia.example', channel: 'linkedin', contact_name: 'Lina Note', company_name: 'Xenia' },
  ];
  assert.deepEqual(matchDrafts(rows, 'xenia').map((d) => d.contact_name), ['Maya Moreau', 'Lina Note'], 'the newest of each');
  assert.deepEqual(matchDrafts(rows, 'old draft').map((d) => d.contact_name), ['Old Draft'], 'an older one still matches on its own');
});

test('a company result searched from Pipeline opens over the same list, filters and page kept', () => {
  assert.equal(companyHref('granite-freight.example', '#/home'), '#/pipeline/granite-freight.example');
  assert.equal(companyHref('granite-freight.example', ''), '#/pipeline/granite-freight.example');
  assert.equal(companyHref('granite-freight.example', '#/drafts/acme.example?channel=email'), '#/pipeline/granite-freight.example', "another screen's query stays there");
  assert.equal(companyHref('granite-freight.example', '#/pipeline?stage=sent&page=3'), '#/pipeline/granite-freight.example?stage=sent&page=3');
  assert.equal(
    companyHref('granite-freight.example', '#/pipeline/lumen-labs.example?q=data%20co&query=fintech&stage=sent&sort=x'),
    '#/pipeline/granite-freight.example?q=data%20co&stage=sent&query=fintech',
    'from an open drawer too; only the list part comes along',
  );
});
