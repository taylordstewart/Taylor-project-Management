// Shipping list check — pure rule-based logic (no network calls, no AI).
// Kept separate from the Netlify handler so it can be unit tested.

export const CONFIG = {
  sourceBoardId: '5f4571e411ffe51cdbd2f005', // Campaign Operations Tracker
  activeListNames: [
    'No Art',
    'Art Files Received',
    'Art Sent To Printer',
    'Received Proofs',
    'Proof Approved',
    'Kitting/Shipping',
  ],
  shipDateFieldId: '61f17abffa687612042d2436', // "Target/Est. Ship Date" (text)
  statusFieldIds: [
    '61f1792a343a8d30c6b83d3a', // Status
    '61f179492f9bdf409cffe64c', // Status 2
    '62fe59f718342a8cfefc01cf', // Status 3
  ],
  targetBoardId: '6a91c5473a3401bfa2591b71', // Taylor — Work Command Center
  targetListId: '6a91c5643a3401bfa2593d17', // 📝 To Do
  timeZone: 'America/Chicago',
  windowDays: 7,
};

const DAY_MS = 86400000;

// ---------- "List needed" matching ----------

// Matches live option text such as "PQ List Needed", "Mailer/Shipping List Needed",
// "PQ/Direct Shipping Needed", "Needs PQ List", "Needs PQ/Direct Shipping".
// Requires a "need" word so a future option like "PQ List Received" is NOT flagged,
// and deliberately does not match "List Match Needed" (a different workflow step).
export function isListNeededStatus(value) {
  if (!value) return false;
  const s = String(value).toLowerCase().replace(/\s+/g, ' ');
  const needWord = /\bneed(s|ed)?\b/.test(s);
  if (!needWord) return false;
  return (
    s.includes('list needed') ||
    s.includes('pq list') ||
    s.includes('mailer') ||
    s.includes('pq/direct shipping') ||
    s.includes('direct shipping')
  );
}

// ---------- Dates ----------

// Calendar day number (days since epoch) for a Y/M/D, or null if not a real date.
export function dayNumber(y, m, d) {
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

export function dayToParts(day) {
  const dt = new Date(day * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function formatDay(day) {
  const { y, m, d } = dayToParts(day);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(day * DAY_MS).getUTCDay()];
  return `${dow} ${m}/${d}/${y}`;
}

export function isoDay(day) {
  const { y, m, d } = dayToParts(day);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Today's calendar day in the given IANA time zone (so an 8am Central run uses the Central date).
export function todayInZone(timeZone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return dayNumber(Number(parts.year), Number(parts.month), Number(parts.day));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function normalizeYear(y) {
  if (y < 100) return 2000 + y;
  return y;
}

// When no year is written ("10/8"), pick the year that puts the date closest to today.
function inferYear(m, d, today) {
  const { y } = dayToParts(today);
  let best = null;
  for (const cand of [y - 1, y, y + 1]) {
    const day = dayNumber(cand, m, d);
    if (day === null) continue;
    if (best === null || Math.abs(day - today) < Math.abs(best - today)) best = day;
  }
  return best;
}

// Parse every date found in a free-text ship date field.
// Handles: 10/8/2026, 10/8/26, 10/8, 10-8-2026, 2026-10-08, "October 8, 2026", "Oct 8th",
// and text around them ("Week of 10/12", "10/8 - 10/10", "Wave 1 10/8; Wave 2 10/15").
// Returns an array of day numbers (possibly empty = unparseable).
export function parseShipDates(text, today) {
  if (!text || !String(text).trim()) return [];
  let s = String(text);
  const found = [];
  const consume = (re, fn) => {
    s = s.replace(re, (...args) => {
      const day = fn(args);
      if (day !== null && day !== undefined) found.push(day);
      return ' ';
    });
  };

  // ISO: 2026-10-08 (optionally followed by a time)
  consume(/(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?:T[\d:.]+Z?)?(?!\d)/g, ([, y, m, d]) =>
    dayNumber(Number(y), Number(m), Number(d)),
  );

  // Month name: "October 8, 2026", "Oct. 8th 2026", "Oct 8"
  consume(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi,
    ([, mon, d, y]) => {
      const m = MONTHS.indexOf(mon.slice(0, 3).toLowerCase()) + 1;
      return y ? dayNumber(Number(y), m, Number(d)) : inferYear(m, Number(d), today);
    },
  );

  // Numeric with year: 10/8/2026, 10/8/26, 10-8-2026, 10.8.26
  consume(/(?<!\d)(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?!\d)/g, ([, m, , d, y]) =>
    dayNumber(normalizeYear(Number(y)), Number(m), Number(d)),
  );

  // Numeric without year: 10/8 (slash only, to avoid misreading ranges like "8-10")
  consume(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g, ([, m, d]) =>
    Number(m) >= 1 && Number(m) <= 12 ? inferYear(Number(m), Number(d), today) : null,
  );

  return [...new Set(found)].sort((a, b) => a - b);
}

// ---------- Card evaluation ----------

// fieldMeta: Map<fieldId, { name, options: Map<optionId, text> }>
// Returns { outcome: 'flagged' | 'skipped' | 'not-flagged', ... } for one card.
export function evaluateCard(card, { fieldMeta, today, windowDays = CONFIG.windowDays }) {
  const items = card.customFieldItems || [];
  const byField = new Map(items.map((i) => [i.idCustomField, i]));

  const neededStatuses = [];
  for (const fieldId of CONFIG.statusFieldIds) {
    const item = byField.get(fieldId);
    if (!item || !item.idValue) continue;
    const meta = fieldMeta.get(fieldId);
    const text = meta?.options.get(item.idValue);
    if (text && isListNeededStatus(text)) {
      neededStatuses.push({ field: meta.name, value: text });
    }
  }

  const rawShip = byField.get(CONFIG.shipDateFieldId)?.value?.text?.trim() || '';
  if (!rawShip) {
    return { outcome: 'skipped', reason: 'missing ship date', rawShip, neededStatuses };
  }
  const dates = parseShipDates(rawShip, today);
  if (dates.length === 0) {
    return { outcome: 'skipped', reason: 'unparseable ship date', rawShip, neededStatuses };
  }

  // If the field holds several dates (e.g. split shipments), any date in the window counts.
  const inWindow = dates.find((d) => d - today >= 0 && d - today <= windowDays);
  const overdue = dates.every((d) => d < today);

  if (inWindow !== undefined && neededStatuses.length > 0) {
    return { outcome: 'flagged', shipDay: inWindow, daysOut: inWindow - today, rawShip, dates, neededStatuses };
  }
  return { outcome: 'not-flagged', rawShip, dates, neededStatuses, overdue };
}

export function jobNumber(cardName) {
  const m = String(cardName || '').match(/\b[A-Z]{2,6}-\d{2,5}[A-Z]?\b/);
  return m ? m[0] : String(cardName || '').trim();
}

// ---------- Digest ----------

function daysOutLabel(n) {
  if (n === 0) return 'TODAY';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}

// flagged: [{ job, cardName, url, listName, shipDay, daysOut, rawShip, neededStatuses }]
export function buildDigest(flagged, today, { windowDays = CONFIG.windowDays } = {}) {
  const sorted = [...flagged].sort((a, b) => a.shipDay - b.shipDay || a.job.localeCompare(b.job));
  const title = `Shipping list check — ${isoDay(today)}`;
  const count = sorted.length;
  const intro =
    `${count} campaign${count === 1 ? '' : 's'} ship${count === 1 ? 's' : ''} within ${windowDays} days ` +
    `but still show${count === 1 ? 's' : ''} a "list needed" status. Confirm the shipping list before it becomes a late shipment.`;

  const lines = sorted.map((f) => {
    const statuses = f.neededStatuses.map((s) => `${s.field}: ${s.value}`).join('; ');
    const { y, m, d } = dayToParts(f.shipDay);
    // Show the raw text when it isn't a plain M/D/YYYY, so odd entries are visible in the digest.
    const shipNote = f.rawShip !== `${m}/${d}/${y}` ? ` (field reads "${f.rawShip}")` : '';
    return {
      f,
      statuses,
      md: `- **${f.job}** — ships ${formatDay(f.shipDay)} (${daysOutLabel(f.daysOut)})${shipNote} — ${statuses} — list: ${f.listName} — ${f.url}`,
    };
  });

  let description = `**${title}**\n\n${intro}\n\n${lines.map((l) => l.md).join('\n')}\n\n` +
    `_Generated by the shipping-list-check Netlify function (rule-based: ship date within ${windowDays} days + Status/Status 2/Status 3 showing a list-needed value)._`;
  // Trello card descriptions max out at 16,384 characters.
  if (description.length > 16000) description = description.slice(0, 15950) + '\n\n…(truncated — see function logs)';

  const teamsPayload = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          msteams: { width: 'Full' },
          body: [
            { type: 'TextBlock', text: `🚚 ${title}`, weight: 'Bolder', size: 'Medium', wrap: true },
            { type: 'TextBlock', text: intro, wrap: true, spacing: 'Small' },
            ...lines.map((l) => ({
              type: 'TextBlock',
              wrap: true,
              spacing: 'Small',
              text:
                `**[${l.f.job}](${l.f.url})** — ships ${formatDay(l.f.shipDay)} (${daysOutLabel(l.f.daysOut)})` +
                ` · ${l.statuses} · ${l.f.listName}`,
            })),
          ],
        },
      },
    ],
  };

  return { title, description, teamsPayload, sorted };
}
