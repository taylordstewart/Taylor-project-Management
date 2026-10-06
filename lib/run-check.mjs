// Orchestrates one run: read Trello -> evaluate cards -> (if anything flagged) Trello summary card + Teams post.
import { CONFIG, buildDigest, evaluateCard, formatDay, isListNeededStatus, isoDay, jobNumber, timingText, todayInZone } from './shipping-check.mjs';
import { createTrelloClient } from './trello.mjs';

const log = (...a) => console.log('[shipping-list-check]', ...a);
const warn = (...a) => console.warn('[shipping-list-check]', ...a);

// Options:
//   env      — { TRELLO_API_KEY, TRELLO_API_TOKEN, TEAMS_WEBHOOK_URL, DRY_RUN, TODAY_OVERRIDE }
//   now      — Date (for tests)
export async function runShippingListCheck({ env = process.env, now = new Date() } = {}) {
  const dryRun = /^(1|true|yes)$/i.test(env.DRY_RUN || '');
  let today = todayInZone(CONFIG.timeZone, now);
  if (env.TODAY_OVERRIDE) {
    const [y, m, d] = env.TODAY_OVERRIDE.split('-').map(Number);
    today = Math.round(Date.UTC(y, m - 1, d) / 86400000);
    log(`TODAY_OVERRIDE set — treating today as ${isoDay(today)}`);
  }
  log(`Run started ${now.toISOString()} | today (${CONFIG.timeZone}) = ${formatDay(today)} | window = ${CONFIG.windowDays} days | dryRun = ${dryRun}`);

  const trello = createTrelloClient({ key: env.TRELLO_API_KEY, token: env.TRELLO_API_TOKEN });

  // 1. Lists — fetched fresh each run, matched by name (case/whitespace-insensitive).
  const boardLists = await trello.get(`/boards/${CONFIG.sourceBoardId}/lists`, { filter: 'open', fields: 'name' });
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const wanted = new Set(CONFIG.activeListNames.map(norm));
  const activeLists = boardLists.filter((l) => wanted.has(norm(l.name)));
  const missing = CONFIG.activeListNames.filter((n) => !activeLists.some((l) => norm(l.name) === norm(n)));
  log(`Active lists found (${activeLists.length}/${CONFIG.activeListNames.length}): ${activeLists.map((l) => l.name).join(', ')}`);
  if (missing.length) warn(`WARNING: expected lists not found on board (renamed or archived?): ${missing.join(', ')}`);

  // 2. Custom field definitions — live option text per status field.
  const fields = await trello.get(`/boards/${CONFIG.sourceBoardId}/customFields`);
  const fieldMeta = new Map(
    fields.map((f) => [f.id, { name: f.name, options: new Map((f.options || []).map((o) => [o.id, o.value?.text ?? ''])) }]),
  );
  for (const id of [CONFIG.shipDateFieldId, ...CONFIG.statusFieldIds]) {
    if (!fieldMeta.has(id)) warn(`WARNING: custom field ${id} not found on board`);
  }
  for (const id of CONFIG.statusFieldIds) {
    const meta = fieldMeta.get(id);
    if (!meta) continue;
    const matching = [...meta.options.values()].filter(isListNeededStatus);
    log(`"${meta.name}" options treated as list-needed: ${matching.length ? matching.map((v) => `"${v}"`).join(', ') : '(none)'}`);
  }

  // 3. Cards in each active list, with custom field values (one request per list, in parallel).
  const perList = await Promise.all(
    activeLists.map(async (list) => {
      const cards = await trello.get(`/lists/${list.id}/cards`, {
        customFieldItems: 'true',
        fields: 'name,shortUrl,idList,closed,labels,start',
      });
      if (cards.length >= 1000) warn(`WARNING: list "${list.name}" returned ${cards.length} cards; results may be truncated`);
      return cards.filter((c) => !c.closed).map((c) => ({ ...c, listName: list.name }));
    }),
  );
  const cards = perList.flat();
  log(`Cards to check: ${cards.length} (${perList.map((c, i) => `${activeLists[i].name}: ${c.length}`).join(', ')})`);

  // 4. Evaluate.
  const flagged = [];
  const skipped = [];
  const overdueNeeded = [];
  let shippedCount = 0;
  let handPostingCount = 0;
  for (const card of cards) {
    const r = evaluateCard(card, { fieldMeta, today });
    const job = jobNumber(card.name);
    const statuses = r.neededStatuses.length ? r.neededStatuses.map((s) => `${s.field}: ${s.value}`).join('; ') : 'no list-needed status';
    // One line per card: what it is, the countdown to its target (or estimated) ship date, and its list status.
    const line = `${job} [${card.listName}]${r.calling ? ' [Calling Project]' : ''} — ${timingText(r)} — ${statuses}`;
    if (r.outcome === 'flagged') {
      flagged.push({ job, cardName: card.name, url: card.shortUrl, listName: card.listName, ...r });
      const why = { window: 'ships within window', asap: 'ASAP', 'no-date': 'Calling Project with no ship date' }[r.reason];
      log(`FLAG (${why}) ${line}`);
    } else if (r.outcome === 'skipped') {
      skipped.push({ job, reason: r.reason, rawShip: r.rawShip });
      log(`SKIP (${r.reason}) ${line}`);
    } else if (r.handPosting) {
      handPostingCount++;
      log(`OK (Hand Posting — not checked) ${line}`);
    } else if (r.shipped) {
      shippedCount++;
      log(`OK (already shipped) ${line}`);
    } else if (r.overdue && r.neededStatuses.length) {
      overdueNeeded.push(job);
      // Target date already passed but list still needed — outside the 7-day rule, so logged rather than flagged.
      log(`PAST (target date passed, not flagged) ${line} — ${card.shortUrl}`);
    } else {
      log(`OK ${line}`);
    }
  }

  const byReason = (k) => flagged.filter((f) => f.reason === k).length;
  const summary = {
    today: isoDay(today),
    cardsChecked: cards.length,
    flagged: flagged.length,
    flaggedByReason: { window: byReason('window'), asap: byReason('asap'), noDateCalling: byReason('no-date') },
    skipped: skipped.length,
    alreadyShipped: shippedCount,
    handPostingNotChecked: handPostingCount,
    overdueStillListNeeded: overdueNeeded.length,
    trelloCard: null,
    teams: null,
    dryRun,
  };

  // 5. Silent when nothing to flag.
  if (flagged.length === 0) {
    log(`Nothing to flag — no Trello card or Teams message sent.`);
    log(`SUMMARY ${JSON.stringify({ ...summary, trelloRequests: trello.requestCount })}`);
    return summary;
  }

  const digest = buildDigest(flagged, today);
  log(`Digest:\n${digest.description}`);

  if (dryRun) {
    log('DRY_RUN — skipping Trello card creation and Teams post.');
    log(`SUMMARY ${JSON.stringify({ ...summary, trelloRequests: trello.requestCount })}`);
    return { ...summary, digest };
  }

  const errors = [];

  // 6a. One summary card per day. If today's card already exists (e.g. a manual re-run), update it instead of duplicating.
  try {
    const existing = (await trello.get(`/lists/${CONFIG.targetListId}/cards`, { fields: 'name,shortUrl' }))
      .find((c) => c.name === digest.title);
    if (existing) {
      await trello.put(`/cards/${existing.id}`, { desc: digest.description });
      summary.trelloCard = { action: 'updated', url: existing.shortUrl };
    } else {
      const created = await trello.post('/cards', {
        idList: CONFIG.targetListId,
        name: digest.title,
        desc: digest.description,
        pos: 'top',
      });
      summary.trelloCard = { action: 'created', url: created.shortUrl };
    }
    log(`Trello summary card ${summary.trelloCard.action}: ${summary.trelloCard.url}`);
  } catch (e) {
    errors.push(`Trello card: ${e.message}`);
    console.error('[shipping-list-check] Failed to write Trello summary card:', e);
  }

  // 6b. Teams.
  if (!env.TEAMS_WEBHOOK_URL) {
    errors.push('TEAMS_WEBHOOK_URL is not set');
    console.error('[shipping-list-check] TEAMS_WEBHOOK_URL is not set — Teams post skipped');
  } else {
    try {
      const res = await fetch(env.TEAMS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(digest.teamsPayload),
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
      summary.teams = { status: res.status };
      log(`Teams message posted (HTTP ${res.status})`);
    } catch (e) {
      errors.push(`Teams: ${e.message}`);
      console.error('[shipping-list-check] Failed to post to Teams:', e);
    }
  }

  log(`SUMMARY ${JSON.stringify({ ...summary, trelloRequests: trello.requestCount, errors })}`);
  if (errors.length) throw new Error(`shipping-list-check finished with errors: ${errors.join(' | ')}`);
  return summary;
}
