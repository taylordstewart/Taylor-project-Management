import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG,
  buildDigest,
  dayNumber,
  evaluateCard,
  isListNeededStatus,
  jobNumber,
  parseShipDates,
  todayInZone,
} from '../lib/shipping-check.mjs';

const today = dayNumber(2026, 10, 6);
const D = (m, d, y = 2026) => dayNumber(y, m, d);

test('list-needed matching against live board option text', () => {
  for (const v of [
    'PQ List Needed',
    'Mailer/Shipping List Needed',
    'PQ/Direct Shipping Needed',
    'Needs PQ List',
    'Needs PQ/Direct Shipping',
    'pq list needed',
  ]) assert.equal(isListNeededStatus(v), true, v);

  for (const v of [
    'List Match Needed',
    'Art Files Needed',
    'IO/SOF Needed',
    'Digital Art Needed',
    'LIVE',
    'HOLD',
    'PQ List Received',
    '',
    null,
  ]) assert.equal(isListNeededStatus(v), false, String(v));
});

test('parses common ship date formats', () => {
  assert.deepEqual(parseShipDates('10/8/2026', today), [D(10, 8)]);
  assert.deepEqual(parseShipDates('10/8/26', today), [D(10, 8)]);
  assert.deepEqual(parseShipDates('10/08', today), [D(10, 8)]);
  assert.deepEqual(parseShipDates('10-8-2026', today), [D(10, 8)]);
  assert.deepEqual(parseShipDates('2026-10-08', today), [D(10, 8)]);
  assert.deepEqual(parseShipDates('October 8, 2026', today), [D(10, 8)]);
  assert.deepEqual(parseShipDates('Oct. 8th', today), [D(10, 8)]);
  assert.deepEqual(parseShipDates('Week of 10/12', today), [D(10, 12)]);
  assert.deepEqual(parseShipDates('10/8 - 10/10', today), [D(10, 8), D(10, 10)]);
  assert.deepEqual(parseShipDates('Wave 1: 9/30/26; Wave 2: 10/9/26', today), [D(9, 30), D(10, 9)]);
});

test('year inference for M/D near a year boundary', () => {
  const dec = dayNumber(2026, 12, 29);
  assert.deepEqual(parseShipDates('1/3', dec), [dayNumber(2027, 1, 3)]);
});

test('unparseable ship dates return nothing', () => {
  for (const v of ['TBD', 'ASAP', '', '   ', '27/27', '13/45/2026', 'pending client']) {
    assert.deepEqual(parseShipDates(v, today), [], v);
  }
});

test('todayInZone uses Central date, not UTC date', () => {
  // 03:00 UTC Oct 7 is still Oct 6 in Chicago.
  assert.equal(todayInZone('America/Chicago', new Date('2026-10-07T03:00:00Z')), D(10, 6));
});

const fieldMeta = new Map([
  ['61f1792a343a8d30c6b83d3a', { name: 'Status', options: new Map([['s1-pq', 'PQ List Needed'], ['s1-live', 'LIVE']]) }],
  ['61f179492f9bdf409cffe64c', { name: 'Status 2', options: new Map([['s2-pq', 'PQ/Direct Shipping Needed'], ['s2-hold', 'HOLD']]) }],
  ['62fe59f718342a8cfefc01cf', { name: 'Status 3', options: new Map([['s3-pq', 'Needs PQ List'], ['s3-match', 'List Match Needed']]) }],
]);

const card = (ship, statusIds = {}, labels = []) => ({
  name: 'IEHP-0001',
  labels: labels.map((name) => ({ name })),
  customFieldItems: [
    ...(ship === undefined ? [] : [{ idCustomField: CONFIG.shipDateFieldId, value: { text: ship } }]),
    ...Object.entries(statusIds).map(([idCustomField, idValue]) => ({ idCustomField, idValue })),
  ],
});

test('flags card in window with list-needed on any status field', () => {
  const r = evaluateCard(card('10/8/2026', { '61f179492f9bdf409cffe64c': 's2-pq' }), { fieldMeta, today });
  assert.equal(r.outcome, 'flagged');
  assert.equal(r.daysOut, 2);
  assert.deepEqual(r.neededStatuses, [{ field: 'Status 2', value: 'PQ/Direct Shipping Needed' }]);

  const r3 = evaluateCard(card('10/13/2026', { '62fe59f718342a8cfefc01cf': 's3-pq', '61f1792a343a8d30c6b83d3a': 's1-pq' }), { fieldMeta, today });
  assert.equal(r3.outcome, 'flagged');
  assert.equal(r3.neededStatuses.length, 2);
});

test('window boundaries are inclusive: today and today+7', () => {
  const st = { '61f1792a343a8d30c6b83d3a': 's1-pq' };
  assert.equal(evaluateCard(card('10/6/2026', st), { fieldMeta, today }).outcome, 'flagged');
  assert.equal(evaluateCard(card('10/13/2026', st), { fieldMeta, today }).outcome, 'flagged');
  assert.equal(evaluateCard(card('10/14/2026', st), { fieldMeta, today }).outcome, 'not-flagged');
  assert.equal(evaluateCard(card('10/5/2026', st), { fieldMeta, today }).outcome, 'not-flagged');
});

test('does not flag when no status is list-needed', () => {
  const r = evaluateCard(card('10/8/2026', { '61f1792a343a8d30c6b83d3a': 's1-live', '62fe59f718342a8cfefc01cf': 's3-match' }), { fieldMeta, today });
  assert.equal(r.outcome, 'not-flagged');
});

test('skips missing / unparseable ship dates on non-calling cards', () => {
  const st = { '61f1792a343a8d30c6b83d3a': 's1-pq' };
  assert.equal(evaluateCard(card(undefined, st, ['Hand Posting']), { fieldMeta, today }).reason, 'missing ship date');
  assert.equal(evaluateCard(card(undefined, st), { fieldMeta, today }).reason, 'missing ship date');
  assert.equal(evaluateCard(card('TBD', st, ['Calling Project']), { fieldMeta, today }).reason, 'unparseable ship date');
});

test('flags blank ship date only on Calling Project cards with list needed', () => {
  const st = { '61f1792a343a8d30c6b83d3a': 's1-pq' };
  const r = evaluateCard(card(undefined, st, ['Calling Project', 'Coffee Sleeve']), { fieldMeta, today });
  assert.equal(r.outcome, 'flagged');
  assert.equal(r.reason, 'no-date');
  assert.equal(evaluateCard(card('', st, ['calling project']), { fieldMeta, today }).reason, 'no-date');
  // Calling project but list already confirmed -> not flagged
  assert.equal(evaluateCard(card(undefined, { '61f1792a343a8d30c6b83d3a': 's1-live' }, ['Calling Project']), { fieldMeta, today }).outcome, 'skipped');
});

test('flags ASAP ship date when list still needed (any card type)', () => {
  const st = { '61f179492f9bdf409cffe64c': 's2-pq' };
  const r = evaluateCard(card('ASAP', st, ['Hand Posting']), { fieldMeta, today });
  assert.equal(r.outcome, 'flagged');
  assert.equal(r.reason, 'asap');
  assert.equal(evaluateCard(card('asap!!', st), { fieldMeta, today }).reason, 'asap');
  // ASAP but list already in (status LIVE) -> not flagged
  assert.equal(evaluateCard(card('ASAP', { '61f1792a343a8d30c6b83d3a': 's1-live' }), { fieldMeta, today }).outcome, 'not-flagged');
  // ASAP with a real date uses the date
  assert.equal(evaluateCard(card('ASAP - 10/20/2026', st), { fieldMeta, today }).outcome, 'not-flagged');
});

test('job number extraction', () => {
  assert.equal(jobNumber('HUMA-0075A'), 'HUMA-0075A');
  assert.equal(jobNumber('IEHP-0001 - Coffee Sleeves'), 'IEHP-0001');
  assert.equal(jobNumber('Some odd card'), 'Some odd card');
});

test('digest groups flags into sections, ASAP first, window sorted by date', () => {
  const flagged = [
    { job: 'B-0002', url: 'https://trello.com/c/b', listName: 'Proof Approved', reason: 'window', shipDay: D(10, 12), daysOut: 6, rawShip: '10/12/2026', neededStatuses: [{ field: 'Status', value: 'PQ List Needed' }] },
    { job: 'A-0001', url: 'https://trello.com/c/a', listName: 'Kitting/Shipping', reason: 'window', shipDay: D(10, 8), daysOut: 2, rawShip: '10/8', neededStatuses: [{ field: 'Status 2', value: 'PQ/Direct Shipping Needed' }] },
    { job: 'C-0003', url: 'https://trello.com/c/c', listName: 'Proof Approved', reason: 'no-date', rawShip: '', neededStatuses: [{ field: 'Status', value: 'Mailer/Shipping List Needed' }] },
    { job: 'D-0004', url: 'https://trello.com/c/d', listName: 'Proof Approved', reason: 'asap', rawShip: 'ASAP', neededStatuses: [{ field: 'Status 3', value: 'Needs PQ List' }] },
  ];
  const d = buildDigest(flagged, today);
  assert.equal(d.title, 'Shipping list check — 2026-10-06');
  const desc = d.description;
  assert.ok(desc.indexOf('D-0004') < desc.indexOf('A-0001'));
  assert.ok(desc.indexOf('A-0001') < desc.indexOf('B-0002'));
  assert.ok(desc.indexOf('B-0002') < desc.indexOf('C-0003'));
  assert.match(desc, /Ship date says ASAP.*\(1\)/);
  assert.match(desc, /Ships within 7 days \(2\)/);
  assert.match(desc, /Calling project — no ship date set \(1\)/);
  assert.match(desc, /field reads "10\/8"/);
  // title + intro + 3 headings + 4 items
  assert.equal(d.teamsPayload.attachments[0].content.body.length, 9);
});

test('digest omits empty sections', () => {
  const d = buildDigest([{ job: 'A-0001', url: 'u', listName: 'L', reason: 'window', shipDay: D(10, 8), daysOut: 2, rawShip: '10/8/2026', neededStatuses: [{ field: 'Status', value: 'PQ List Needed' }] }], today);
  assert.doesNotMatch(d.description, /\*\*Ship date says ASAP|\*\*Calling project — no ship date set/);
});
