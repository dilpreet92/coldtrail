// Pure parts of the shared components (ui/js/components/). Their DOM behaviour is covered in
// the browser by tests/e2e/specs/shell.spec.js ("components").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterOptions } from '../../ui/js/components/searchSelect.js';

test('filterOptions matches label or value, any case; blank text keeps every option', () => {
  const opts = [
    { value: 'q1', label: 'Seed-stage fintech', count: 3 },
    { value: 'q2', label: 'Devtools in Berlin' },
    { value: 'Q3-raw' },
  ];
  assert.deepEqual(filterOptions(opts, 'FINTECH').map((o) => o.value), ['q1']);
  assert.deepEqual(filterOptions(opts, '  q2 ').map((o) => o.value), ['q2'], 'trimmed, and the value counts');
  assert.deepEqual(filterOptions(opts, 'raw').map((o) => o.value), ['Q3-raw'], 'no label: the value is the label');
  assert.deepEqual(filterOptions(opts, '').map((o) => o.value), ['q1', 'q2', 'Q3-raw']);
  assert.deepEqual(filterOptions(opts, null).map((o) => o.value), ['q1', 'q2', 'Q3-raw']);
  assert.notEqual(filterOptions(opts, ''), opts, 'a copy');
});

test('filterOptions: pinned options head a blank list and are never matched by typing', () => {
  const all = { value: '', label: 'All sources', pinned: true };
  const opts = [
    { value: 'all-hands tooling', label: 'All-hands tooling' },
    all,
    { value: 'sources of truth', label: 'Sources of truth' },
  ];
  assert.deepEqual(filterOptions(opts, '').map((o) => o.label), ['All sources', 'All-hands tooling', 'Sources of truth']);
  assert.deepEqual(filterOptions(opts, '   ')[0], all, 'blank after trimming');
  assert.deepEqual(filterOptions(opts, 'all').map((o) => o.label), ['All-hands tooling'], 'its label never matches');
  assert.deepEqual(filterOptions(opts, 'All sources'), []);
  assert.deepEqual(filterOptions(opts, 'sources').map((o) => o.label), ['Sources of truth']);

  // Several pinned rows keep their own order, ahead of the rest.
  const two = [{ value: 'a', label: 'A' }, { value: '', label: 'Any', pinned: true }, { value: '-', label: 'None', pinned: true }];
  assert.deepEqual(filterOptions(two, '').map((o) => o.label), ['Any', 'None', 'A']);
  // Without pinned options the result is exactly as before.
  const plain = [{ value: 'b' }, { value: 'a' }];
  assert.deepEqual(filterOptions(plain, ''), plain);
});
