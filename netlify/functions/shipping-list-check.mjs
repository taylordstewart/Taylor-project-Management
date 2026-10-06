// Netlify Scheduled Function — weekday shipping-list check for the Campaign Operations Tracker.
// Rule-based only: Trello API + date/status comparison. No AI/LLM calls.
import { runShippingListCheck } from '../../lib/run-check.mjs';

export default async () => {
  try {
    const summary = await runShippingListCheck();
    return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[shipping-list-check] Run failed:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// Netlify cron runs in UTC. 13:00 UTC Mon–Fri = 8:00am Central during daylight time (CDT, UTC-5),
// 7:00am Central during standard time (CST, UTC-6, early Nov – mid Mar).
/** @type {import('@netlify/functions').Config} */
export const config = {
  schedule: '0 13 * * 1-5',
};
