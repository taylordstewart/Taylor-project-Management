# Shipping List Check (Netlify Scheduled Function)

A backend job that runs every weekday morning. It flags campaigns on the **Campaign Operations Tracker** Trello board that ship within 7 days but still have a shipping list that isn't confirmed.

It's rule-based only, using the Trello API plus date and status comparisons. **There are no AI or LLM calls.**

## What it does

1. Pulls the board's lists fresh each run. It keeps the active ones by name: No Art, Art Files Received, Art Sent To Printer, Received Proofs, Proof Approved, Kitting/Shipping.
2. Reads every open card in those lists along with its custom field values.
3. Parses **Target/Est. Ship Date**, a free-text field. Supported formats:
   - `10/8/2026`, `10/8/26`, `10/8`, `10-8-2026`, `2026-10-08`
   - `October 8, 2026`, `Oct. 8th`
   - Dates inside other text, such as `Week of 10/12` or `10/8 - 10/10`

   If the field has more than one date (for example split shipments), any date inside the window counts. Cards with a missing or unparseable ship date (for example `TBD`) are **skipped and logged**.
4. Two kinds of cards are never flagged:
   - **Hand Posting** cards, because they aren't shipped. The exception is a card that is also a **Calling Project**, which is still checked.
   - Cards with an **Actual Ship Date** filled in, because they've already shipped.

   Every other card is flagged in any of these cases:
   - **ASAP, not shipped yet:** the ship date field says "ASAP" with no actual date. This is flagged **whatever the list status is**, because ASAP means the campaign is already past when it should have shipped.
   - **Ships within 7 days:** the card shows a "list needed" value on **Status**, **Status 2** or **Status 3**, and the ship date is between today and today + 7 days, both ends included. "Today" uses the Central time date.
   - **Calling project with no ship date:** the card has the **Calling Project** label, shows a "list needed" value, and its ship date is blank. It's flagged once the estimated ship date (Start − 7 days) is **within the next 7 days or already past**. A card estimated further out is only logged, and so is a card with no Start date, because there's nothing to estimate from.

   When there's no real ship date (blank or "ASAP"), the job estimates one as the **Start** date minus 7 days. It shows how many days until that date, or how many days past it.

   The status option text is read live from the board. A value counts as "list needed" when it contains a need word (`need`, `needs`, `needed`) and one of these: `list needed`, `pq list`, `mailer`, or `direct shipping`. Today that covers:
   - PQ List Needed
   - Mailer/Shipping List Needed
   - PQ/Direct Shipping Needed
   - Needs PQ List
   - Needs PQ/Direct Shipping

   It does **not** match `List Match Needed`. Each run's log lists exactly which options it treated as "list needed."
5. If one or more cards are flagged:
   - **Trello:** creates one summary card, `Shipping list check — YYYY-MM-DD`, at the top of **📝 To Do** on *Taylor — Work Command Center*. Flags are grouped into three sections: ASAP, ships within 7 days, and calling project with no ship date (estimated ship date within 7 days). The description lists each card's job number, ship date, how many days out, the status field and value, the list, and a link. If you re-run on the same day, it updates that day's card instead of making a duplicate.
   - **Teams:** posts the same digest to your channel through the webhook.
6. If nothing is flagged, it stays silent: no card and no Teams message.

## Dashboard endpoint (read-only)

`GET https://shippinglistcheck.netlify.app/api/flags` runs the same rules against the live board and returns the current flags as JSON. Your dashboard uses it.

- **Never writes.** It doesn't post to Teams or create or update Trello cards.
- **Uses the same Netlify environment variables** as the daily job. The Trello key and token stay on Netlify and never reach the browser.
- **Callable from any site.** Results are cached on Netlify for 60 seconds, so a busy dashboard doesn't overload Trello.
- **Response:** `{ asOf, today, todayLabel, cardsChecked, total, sections: [{ key, heading, items: [{ job, url, list, reason, shipText, statuses, daysOut }] }] }`.
  - `daysOut` is positive for days until the ship date and negative for days past it.
  - For blank or ASAP ship dates, it uses the Start − 7 estimate.

## Schedule

`0 13 * * 1-5` runs Monday to Friday at 13:00 UTC. Netlify cron always runs in UTC:

| Period | Central time | Offset |
|---|---|---|
| Mid-March to early November (CDT) | **8:00am** | UTC−5 |
| Early November to mid-March (CST) | **7:00am** | UTC−6 |

If you'd rather run at 8:00am all winter and 9:00am in summer, change it to `0 14 * * 1-5` in `netlify/functions/shipping-list-check.mjs`.

## Files

| Path | Purpose |
|---|---|
| `netlify/functions/shipping-list-check.mjs` | Netlify entry point and cron schedule |
| `netlify/functions/shipping-flags.mjs` | Read-only `/api/flags` endpoint for the dashboard |
| `lib/run-check.mjs` | One full run: fetch, evaluate, post |
| `lib/shipping-check.mjs` | Pure logic: board/field/list IDs, date parsing, status matching, digest formatting |
| `lib/trello.mjs` | Trello REST client with retry on rate limits |
| `scripts/run-local.mjs` | Run against the live board from your machine (dry run by default) |
| `test/shipping-check.test.mjs` | Unit tests (`npm test`) |

## Environment variables (Netlify → Site configuration → Environment variables)

| Variable | Required | Value |
|---|---|---|
| `TRELLO_API_KEY` | yes | Your Trello API key |
| `TRELLO_API_TOKEN` | yes | A Trello token with read and write access |
| `TEAMS_WEBHOOK_URL` | yes | The Teams webhook URL (see below) |
| `DRY_RUN` | no | Set to `true` to log the digest without creating a card or posting to Teams. Delete it when you go live. |
| `TODAY_OVERRIDE` | no | For testing only. Set to `YYYY-MM-DD` to pretend the run happens on that date. |

Make sure the variables are available to **Functions**. That's the default scope.

## Getting a Trello API key and token

1. Go to <https://trello.com/power-ups/admin> and click **New**.
2. Create an integration (for example "Shipping List Check") in the Mesmerize workspace.
3. Open the integration and go to the **API key** tab. Click **Generate a new API key** and copy it. This is `TRELLO_API_KEY`.
4. On the same page, click the **Token** link next to the key and approve the access. Copy the token. This is `TRELLO_API_TOKEN`.
   - The token acts as the Trello user who approved it, and summary cards will show as created by that user.
   - The token needs **read and write** access, because it creates cards.
   - That user must be able to see both boards.
5. Treat the token like a password. Store it only in Netlify environment variables. Never commit it.

## Setting up the Teams webhook

Microsoft is retiring the old Office 365 "Incoming Webhook" connectors. The supported replacement is a **Workflows** webhook. The function sends an Adaptive Card, which works with both.

**Recommended: Workflows**

1. In Teams, open the target channel. Click **⋯** (More options), then **Workflows**.
2. Choose the template **"Send webhook alerts to a channel"** (it may also be called "Post to a channel when a webhook request is received").
3. Name it (for example "Shipping list check"), confirm the team and channel, then click **Add workflow**.
4. Copy the URL it gives you. This is `TEAMS_WEBHOOK_URL`.

**Legacy: Incoming Webhook connector** (if your tenant still allows it)

1. In the channel, click **⋯**, then **Manage channel**, then **Connectors** (or **Edit**).
2. Find **Incoming Webhook** and click **Configure**. Name it and create it.
3. Copy the URL.

## Deploying

1. In Netlify, go to **Add new project**, then **Import an existing project**, and pick this GitHub repo. If the repo is already linked to a Netlify project, just push or merge to the production branch.
2. Leave the build settings as they are. `netlify.toml` already points Functions at `netlify/functions`.
3. Add the environment variables above. Start with `DRY_RUN=true`.
4. Deploy. Scheduled functions only run on the **published production deploy**. They don't run on deploy previews or branch deploys.

## Testing before you trust the schedule

**1. Unit tests (no credentials needed)**

```bash
npm test
```

**2. Dry run against the live board from your machine (writes nothing)**

```bash
TRELLO_API_KEY=xxx TRELLO_API_TOKEN=yyy npm run check:dry
# Pretend it's a different day:
TRELLO_API_KEY=xxx TRELLO_API_TOKEN=yyy TODAY_OVERRIDE=2026-10-12 npm run check:dry
```

Read the output, then spot-check two or three FLAG and SKIP lines against the board.

**3. Dry run on Netlify**

1. With `DRY_RUN=true` set, go to **Logs & metrics**, then **Functions**, then **shipping-list-check**.
2. Click **Run now**. Scheduled functions have this button, and they can't be called by URL in production.
3. Check the log output.

**4. Live run**

1. Delete `DRY_RUN`, then redeploy so the change takes effect.
2. Click **Run now** again.
3. Confirm that the card appears in 📝 To Do and that the message lands in Teams. Running it again the same day updates the card rather than making a duplicate. The Teams message posts again each time.

**Optional: Netlify CLI**

`netlify dev`, then in another terminal run `netlify functions:invoke shipping-list-check`. This runs with your local `.env` values.

## Reading the logs

Every run prints lines prefixed with `[shipping-list-check]`:

- `Run started …`: the timestamp, "today" in Central time, and whether it's a dry run.
- `Active lists found (6/6) …`: a `WARNING` appears if a list was renamed or archived.
- `"Status 2" options treated as list-needed: …`: shows the matching rules applied to the live options.
- `Cards to check: N (per-list counts)`
- One line for every card, showing its target ship date countdown (for example `in 2 days` or `3 days past`), or the estimated date from Start − 7 days, plus its list status. The line starts with one of these:
  - `FLAG (…)`: flagged, with the reason.
  - `SKIP (…)`: no usable ship date, and it isn't a case that gets flagged.
  - `PAST`: the target date already passed and the list is still needed.
  - `OK (already shipped)`: Actual Ship Date is filled in.
  - `OK (Hand Posting — not checked)`: a hand-posted card.
  - `OK`: nothing to do.
- `SUMMARY {…}`: one JSON line with today's date, the cards checked, flagged and skipped counts, the Trello card URL, Teams status, the Trello request count, and any errors.

If the Trello card or Teams post fails, the run logs the error and ends as failed, so it shows up in Netlify. A failure on one doesn't block the other.

## Rate limits and pagination

- Each run makes about 9 Trello requests: lists, custom fields, one per active list, and then one or two to write the summary card. That's far below Trello's limit of 100 requests per 10 seconds per token.
- Cards are fetched per list. Trello returns a list's full contents in one response, so there's no paging to manage.
- If any list ever returns 1,000 or more cards, the log shows a warning.
- If Trello returns 429 or a 5xx error, the request is retried up to 3 times. It waits as long as `Retry-After` says, or else backs off 1s, 2s, 4s.
