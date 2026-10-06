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
  countdown,
  timingText,
  buildFlagsReport,
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

const ACTUAL = '6a315156d1b43b9a6a13aead';
const START = '68630012ddcfdbf550390e40';
const card = (ship, statusIds = {}, labels = [], extra = []) => ({
  name: 'IEHP-0001',
  labels: labels.map((name) => ({ name })),
  customFieldItems: [
    ...extra,
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
  assert.equal(evaluateCard(card(undefined, st, ['Mailer']), { fieldMeta, today }).reason, 'missing ship date');
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

test('flags ASAP ship date when not yet shipped (any list status)', () => {
  const st = { '61f179492f9bdf409cffe64c': 's2-pq' };
  const r = evaluateCard(card('ASAP', st, ['Mailer']), { fieldMeta, today });
  assert.equal(r.outcome, 'flagged');
  assert.equal(r.reason, 'asap');
  assert.equal(evaluateCard(card('asap!!', st), { fieldMeta, today }).reason, 'asap');
  // ASAP with the list already in (status LIVE) is still flagged — it hasn't shipped
  const live = evaluateCard(card('ASAP', { '61f1792a343a8d30c6b83d3a': 's1-live' }, ['Mailer']), { fieldMeta, today });
  assert.equal(live.reason, 'asap');
  assert.equal(live.neededStatuses.length, 0);
  assert.match(buildDigest([{ job: 'FLDH-0032A', url: 'u', listName: 'L', ...live }], today).description, /list in — no Actual Ship Date yet/);
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
  assert.match(desc, /ASAP — not shipped yet \(1\)/);
  assert.match(desc, /Ships within 7 days \(2\)/);
  assert.match(desc, /Calling project — no ship date set \(1\)/);
  assert.match(desc, /field reads "10\/8"/);
  // title + intro + 3 headings + 4 items
  assert.equal(d.teamsPayload.attachments[0].content.body.length, 9);
});

test('digest omits empty sections', () => {
  const d = buildDigest([{ job: 'A-0001', url: 'u', listName: 'L', reason: 'window', shipDay: D(10, 8), daysOut: 2, rawShip: '10/8/2026', neededStatuses: [{ field: 'Status', value: 'PQ List Needed' }] }], today);
  assert.doesNotMatch(d.description, /\*\*ASAP — not shipped yet|\*\*Calling project — no ship date set/);
});

test('Actual Ship Date filled = shipped, never flagged', () => {
  const st = { '61f1792a343a8d30c6b83d3a': 's1-pq' };
  const shipped = [{ idCustomField: ACTUAL, value: { date: '2026-10-05T17:00:00.000Z' } }];
  for (const ship of ['10/8/2026', 'ASAP', undefined]) {
    const r = evaluateCard(card(ship, st, ['Calling Project'], shipped), { fieldMeta, today });
    assert.equal(r.outcome, 'not-flagged', String(ship));
    assert.equal(r.shipped, true);
  }
});

test('estimated ship date = Start - 7 days, with countdown', () => {
  const st = { '61f1792a343a8d30c6b83d3a': 's1-pq' };
  // Start Mon 10/12 (noon UTC) -> est. ship Mon 10/5 -> 1 day past on 10/6
  const startItem = [{ idCustomField: START, value: { date: '2026-10-12T17:00:00.000Z' } }];
  const r = evaluateCard(card('ASAP', st, [], startItem), { fieldMeta, today });
  assert.equal(r.reason, 'asap');
  assert.equal(r.est.estShipDay, D(10, 5));
  assert.equal(r.est.daysOut, -1);
  assert.match(timingText(r), /est\. ship Mon 10\/5\/2026 \(Start Mon 10\/12\/2026 − 7d\) — 1 day past/);
  const d = buildDigest([{ job: 'X-1', url: 'u', listName: 'L', ...r }], today);
  assert.match(d.description, /1 day past/);

  // Falls back to the card's own start date
  const r2 = evaluateCard({ ...card(undefined, st, ['Calling Project']), start: '2026-10-20T12:00:00.000Z' }, { fieldMeta, today });
  assert.equal(r2.reason, 'no-date');
  assert.equal(r2.est.daysOut, 7);
});

test('countdown wording and target countdown in timing text', () => {
  assert.equal(countdown(0), 'today');
  assert.equal(countdown(1), 'tomorrow');
  assert.equal(countdown(5), 'in 5 days');
  assert.equal(countdown(-1), '1 day past');
  assert.equal(countdown(-3), '3 days past');
  const r = evaluateCard(card('10/8/2026', {}), { fieldMeta, today });
  assert.match(timingText(r), /target ship Thu 10\/8\/2026 — in 2 days/);
  const past = evaluateCard(card('9/30/2026', {}), { fieldMeta, today });
  assert.match(timingText(past), /6 days past/);
});

test('Hand Posting cards are never flagged unless also a Calling Project', () => {
  const st = { '61f1792a343a8d30c6b83d3a': 's1-pq' };
  for (const ship of ['ASAP', '10/8/2026', undefined]) {
    const r = evaluateCard(card(ship, st, ['Hand Posting']), { fieldMeta, today });
    assert.equal(r.outcome, 'not-flagged', String(ship));
    assert.equal(r.handPosting, true);
  }
  assert.equal(evaluateCard(card(undefined, st, ['Hand Posting', 'Calling Project']), { fieldMeta, today }).reason, 'no-date');
});

test('dashboard report mirrors digest sections as plain JSON', () => {
  const flagged = [
    { job: 'A-0001', url: 'u1', listName: 'Kitting/Shipping', reason: 'window', shipDay: D(10, 8), daysOut: 2, rawShip: '10/8/2026', neededStatuses: [{ field: 'Status', value: 'PQ List Needed' }] },
    { job: 'B-0002', url: 'u2', listName: 'Proof Approved', reason: 'asap', rawShip: 'ASAP', neededStatuses: [], est: { startDay: D(10, 1), estShipDay: D(9, 24), daysOut: -12 } },
  ];
  const r = buildFlagsReport(flagged, today, { now: new Date('2026-10-06T15:00:00Z'), cardsChecked: 72 });
  assert.equal(r.total, 2);
  assert.equal(r.cardsChecked, 72);
  assert.deepEqual(r.sections.map((s) => s.key), ['asap', 'window']);
  assert.equal(r.sections[0].items[0].daysOut, -12);
  assert.equal(r.sections[0].items[0].statuses, 'list in — no Actual Ship Date yet');
  assert.equal(r.sections[1].items[0].daysOut, 2);
  assert.equal(buildFlagsReport([], today).sections.length, 0);
});
