// Read-only endpoint for the dashboard: GET /api/flags returns the campaigns the shipping list
// check would flag right now. It never posts to Teams or writes to Trello.
import { CONFIG, buildFlagsReport, todayInZone } from '../../lib/shipping-check.mjs';
import { evaluateBoard } from '../../lib/run-check.mjs';
import { createTrelloClient } from '../../lib/trello.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const json = (body, status, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  try {
    const now = new Date();
    const today = todayInZone(CONFIG.timeZone, now);
    const trello = createTrelloClient({ key: process.env.TRELLO_API_KEY, token: process.env.TRELLO_API_TOKEN });
    const { cards, flagged } = await evaluateBoard({ trello, today });
    const report = buildFlagsReport(flagged, today, { now, cardsChecked: cards.length });
    console.log(`[shipping-flags] served ${report.total} flags from ${cards.length} cards (${trello.requestCount} Trello requests)`);
    // Browsers always re-check; Netlify's CDN reuses a result for 60s so a busy dashboard doesn't hammer Trello.
    return json(report, 200, {
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=60',
    });
  } catch (e) {
    console.error('[shipping-flags] failed:', e);
    return json({ error: 'Could not read the Trello board right now.' }, 502, { 'Cache-Control': 'no-store' });
  }
};

export const config = { path: '/api/flags' };
