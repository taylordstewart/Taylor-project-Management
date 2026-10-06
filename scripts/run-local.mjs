// Run the shipping list check locally against the live Trello board.
// Defaults to DRY_RUN (logs the digest, writes nothing). Set DRY_RUN=false to really post.
//   TRELLO_API_KEY=... TRELLO_API_TOKEN=... node scripts/run-local.mjs
//   TODAY_OVERRIDE=2026-10-12 node scripts/run-local.mjs   # pretend it's another day
import { runShippingListCheck } from '../lib/run-check.mjs';

const env = { ...process.env, DRY_RUN: process.env.DRY_RUN ?? 'true' };
runShippingListCheck({ env }).catch((e) => {
  console.error(e);
  process.exit(1);
});
