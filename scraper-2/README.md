# MagicHat Instagram Scraper

This codebase has five main workflows:

- `eval:accuracy`: compare your 1-4 creator scores against AI scores.
- `eval:speed-cost`: benchmark a standard 250-profile run from the campaign's `speedCostSeed`.
- `crawl`: run the actual frontier crawler.
- `dashboard:legacy`: inspect old local JSON crawl/evaluation results.
- `review`: run one-off manual handle checks.

## Setup

```bash
cp .env.example .env
npm install
```

Fill in `.env` with the required API keys.

## Campaigns

Every workflow runs in the context of one campaign, selected with `OUTBOUND_CAMPAIGN`
(default `day_in_life_creators`). A campaign definition in `src/campaigns/` owns the
definition of a good creator: threshold defaults, hard-no term lists, scoring
(`mode: 'openai'` with a system prompt, or `mode: 'rule'` with a deterministic score
function), the accept rule, and the campaign's gold/seeds file paths.

Current campaigns:

- `day_in_life_creators`: large verified lifestyle creators, scored with OpenAI.
- `ugc_creators`: 1K-50K follower UGC creators matched by bio/username terms;
  rule-scored, no posts scrape, no OpenAI cost.
- `ugc_creators_email`: identical to `ugc_creators` but only accepts creators with a
  contactable email (bio or public business email), for pure cold-email outbound.

Explicit `INSTAGRAM_*` env vars always override campaign defaults. To add a campaign,
create a definition file in `src/campaigns/`, register it in `src/campaigns/index.js`,
and add its gold file under `evals/gold/<campaign>/accuracy.json` and seeds under
`seeds/<campaign>.txt`. Note: the always-on `worker:claim` worker only claims
`scraper_runs` rows matching its own `OUTBOUND_CAMPAIGN`; dashboard-triggered runs
pass the campaign automatically.

## Accuracy Eval

Add handles and your scores to the active campaign's gold file:

```text
evals/gold/<campaign>/accuracy.json
```

Format:

```json
[
  { "handle": "creator1", "humanScore": 4 },
  { "handle": "creator2", "humanScore": 1 }
]
```

Run:

```bash
npm run eval:accuracy
```

The output puts your score next to the AI score and highlights mismatches:

```text
data/eval-runs/accuracy/<campaign>/
```

Accuracy eval always live scrapes every handle in the gold file before scoring. It does not reuse saved scrape packets.

## Speed-Cost Eval

Run:

```bash
npm run eval:speed-cost
```

This benchmark is intentionally hardcoded:

```text
seed = yestheory
limit = 250
followingLimit = 2000
concurrency = 64
```

What happens:

1. Scrapes accounts followed by `@yestheory`.
2. Applies the same cheap prefilters used by the crawler.
3. Processes the first 250 queued profiles through the normal scrape/scoring path.
4. Tracks throughput, total time, total cost, and cost breakdown.

The output is saved under:

```text
data/eval-runs/speed-cost/
```

## Actual Crawl

`scraper-2` now uses Postgres as the source of truth. Set `DATABASE_URL` before running crawls.

Create runs from the dashboard, then have a worker claim the oldest requested or paused run:

```bash
DATABASE_URL='postgresql://...' npm run crawl -- --claim-next
```

Or run from seed handles, which creates a new `scraper_runs` row:

```bash
DATABASE_URL='postgresql://...' npm run crawl -- @seed1 @seed2
```

Useful options:

```bash
DATABASE_URL='postgresql://...' npm run crawl -- --file seeds/day_in_life_creators.txt --following-limit 2000 --qualification-workers 32 --max-accepted 100
```

What happens:

1. Starts from seed profiles.
2. Scrapes accounts each seed follows.
3. Filters private, unverified, known-low-follower, and obvious page/business accounts before deeper scraping.
4. Scrapes profile metadata and recent posts for remaining candidates.
5. Applies deterministic hard-no checks before OpenAI.
6. Scores remaining candidates with OpenAI.
7. Adds accepted creators back into the frontier as future seeds.

Crawler state is saved to `scraper_runs.state`. Scrape events, creator rows, evaluations, costs, and accepted send-queue rows are written to Postgres. Local evaluation review JSON is still saved for raw review packets:

```text
data/evaluations/
data/evaluations.jsonl
```

## Campaign-Wide Dedup (`campaign_seen`)

Every handle a campaign discovers is recorded once in the `campaign_seen` table
(`primary key (campaign, handle)`). The crawler hydrates its in-memory seen map
from this table at claim time, so no handle is ever scraped or scored twice
within a campaign — across sequential runs, concurrent runs, and resumes.

Retry-eligible exceptions: handles that previously `failed`, handles marked
`cap_skipped` (scored accept-worthy but the run's accepted cap was already
reached), and handles left `queued` by a run that is now completed, stopped,
failed, or deleted — any later run adopts those instead of stranding them.

The run's own seen map is no longer stored inside `scraper_runs.state`. The
migration backfills `campaign_seen` from all existing runs' state blobs:

```bash
psql "$DATABASE_URL" -f ../sender-2/sql/migrations/014_add_campaign_seen.sql
```

Workers also heartbeat `scraper_runs.updated_at` every 30 seconds; a run whose
heartbeat has been quiet for 10+ minutes is considered abandoned and can be
re-claimed (the scheduled `worker:claim` does this automatically).

This makes multiple runs per campaign safe and useful: start several runs with
wildly different seed handles to cover more of the target distribution — each
run explores its own corner of the graph and they share one campaign-wide
memory, so overlap costs nothing.

Two related behaviors:

- Claiming a run by `--run-id` only succeeds when the run is `requested` or
  `paused` (or looks abandoned: `running` with no state update for 10+
  minutes), so a dashboard trigger and the scheduled `worker:claim` cannot
  both process the same run. A worker that loses the race exits cleanly.
- Completed, stopped, or failed runs can be extended from the dashboard
  ("extend" raises `max_accepted` and re-requests the run); the crawler
  continues from the saved frontier instead of starting over.

## Dashboard

Use the Postgres-backed app in `../dashborad`. The old local JSON-state dashboard is no longer the control surface.
If you need to inspect old local JSON crawl files, run `npm run dashboard:legacy`.

## Cloud Worker Deployment

The simplest production setup is a Google Cloud Run Job. The dashboard creates `scraper_runs` rows, and the worker claims one requested or paused run:

```bash
npm run worker:claim
```

This command exits successfully when there is no work to claim, so it is safe to run from Cloud Scheduler every minute. When it claims a run, it keeps running until that scraper run completes, pauses, stops, or fails. Dashboard pause/stop controls are cooperative: the worker checks commands between scraper units, so an active Apify or OpenAI request may finish before the worker exits.

Required cloud environment variables:

```text
DATABASE_URL
APIFY_TOKEN
OPENAI_API_KEY
```

Recommended production environment variables:

```text
OUTBOUND_CAMPAIGN=day_in_life_creators
DASHBOARD_ENQUEUE_STATUS=queued
APIFY_MAX_RUN_USD=
```

Optional tuning environment variables:

```text
DATABASE_POOL_MAX
INSTAGRAM_FOLLOWING_LIMIT
INSTAGRAM_RESULTS_LIMIT
INSTAGRAM_FOLLOWER_THRESHOLD
INSTAGRAM_MEDIAN_VIEWS_THRESHOLD
INSTAGRAM_REQUIRE_VERIFIED
INSTAGRAM_PROFILE_PREFILTER
INSTAGRAM_CONTENT_PREFILTER
INSTAGRAM_FOLLOWING_PREFILTER
OPENAI_MODEL
OPENAI_POST_LIMIT
OPENAI_MAX_TEXT_CHARS
APIFY_INSTAGRAM_PROFILE_ACTOR_ID
APIFY_INSTAGRAM_POSTS_ACTOR_ID
APIFY_INSTAGRAM_FOLLOWING_ACTOR_ID
```

Build locally:

```bash
docker build -t magichat-scraper-2 .
```

Run locally against Postgres:

```bash
docker run --rm \
  -e DATABASE_URL='postgresql://...' \
  -e APIFY_TOKEN='...' \
  -e OPENAI_API_KEY='...' \
  -e OUTBOUND_CAMPAIGN='day_in_life_creators' \
  -e DASHBOARD_ENQUEUE_STATUS='queued' \
  magichat-scraper-2
```

Example Google Cloud deploy flow:

```bash
PROJECT_ID=magichat-scraper-prod-zj
REGION=us-central1
REPOSITORY=magichat
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY/magichat-scraper-2"

gcloud artifacts repositories create "$REPOSITORY" \
  --repository-format=docker \
  --location "$REGION"

gcloud builds submit --tag "$IMAGE"

gcloud run jobs create magichat-scraper-2 \
  --image "$IMAGE" \
  --region "$REGION" \
  --task-timeout 24h \
  --max-retries 0 \
  --set-env-vars OUTBOUND_CAMPAIGN=day_in_life_creators,DASHBOARD_ENQUEUE_STATUS=queued \
  --set-secrets DATABASE_URL=DATABASE_URL:latest,APIFY_TOKEN=APIFY_TOKEN:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest
```

Run manually:

```bash
gcloud run jobs execute magichat-scraper-2 --region us-central1
```

Recommended scheduler behavior:

- Execute the Cloud Run Job every minute.
- Keep retries disabled at the job level initially; failed scraper runs are marked in Postgres.
- Use a long timeout such as 24 hours for early runs.
- Start with one scheduled job. Later, multiple jobs can run in parallel because claims use row locking.

Smoke test:

1. Create a scraper run from the dashboard.
2. Execute the Cloud Run Job manually.
3. Confirm the run moves from `requested` to `running`.
4. Click pause or stop in the dashboard and confirm the run eventually becomes `paused` or `stopped`.
5. Confirm Postgres receives scrape events, cost events, creator evaluations, and send queue rows.

## Manual Review

For one-off handle scoring:

```bash
npm run review -- @creator1 @creator2 @creator3
```

Or from a file:

```bash
npm run review -- --file handles.txt
```

## Cost Controls

The defaults are intentionally conservative:

```text
INSTAGRAM_PROFILE_PREFILTER=true
INSTAGRAM_CONTENT_PREFILTER=true
INSTAGRAM_FOLLOWING_PREFILTER=true
INSTAGRAM_RESULTS_LIMIT=3
OPENAI_POST_LIMIT=3
OPENAI_MAX_TEXT_CHARS=320
```

The scraper uses:

- `scraping_solutions/instagram-scraper-followers-following` for following-list discovery.
- `apify/instagram-profile-scraper` for profile metadata.
- `apify/instagram-scraper` with `resultsType: posts` for recent posts.
- OpenAI only after deterministic hard-no filters pass.

Top-comment scraping is not part of the pipeline.

## Email capture + Instantly.ai sync

Every scraped profile now captures contact emails from two sources: the bio text
(regex extraction) and Instagram's business-contact email (Apify `publicEmail`).
Emails land on `creators.emails`; qualified leads (`fit_score >= 3`, configurable
via `INSTANTLY_MIN_FIT_SCORE`) are pushed to Instantly.ai campaigns, one lead per
(creator, campaign, email). Email copy lives in Instantly; we send `username`,
`name`, `follower_count`, `fit_score`, `bio`, `profile_url`, and `source_campaign`
as custom variables. Duplicates are blocked by the `instantly_sync` table plus
`skip_if_in_campaign` (a creator CAN be in both campaigns intentionally).

Setup (one-time):

1. Apply `sender-2/sql/migrations/015_add_creator_contacts_and_instantly_sync.sql`.
2. Create the campaigns in Instantly with their email sequences, then set
   `INSTANTLY_API_KEY`, `INSTANTLY_CAMPAIGN_ID_UGC_CREATORS`,
   `INSTANTLY_CAMPAIGN_ID_DAY_IN_LIFE_CREATORS`, and
   `INSTANTLY_CAMPAIGN_ID_UGC_CREATORS_EMAIL` in `.env`.

Commands (run from `scraper-2/`, which has `.env` and `data/`):

```bash
# Backfill emails from local evaluation files, then print coverage per campaign.
npm run backfill:emails

# Also re-scrape qualified creators that still have no email (costs Apify $):
npm run backfill:emails -- --rescrape            # add --rescrape-limit 100 to cap

# Preview what would be pushed to Instantly (no writes, no API calls):
npm run instantly:sync

# Push a small test batch, then check the leads inside Instantly:
npm run instantly:sync -- --live --limit 20

# Push everything pending:
npm run instantly:sync -- --live
```

Continuous operation: set `INSTANTLY_SYNC_ON_COMPLETE=true` and every *completed*
crawl run pushes its campaign's new leads automatically (pauses/stops don't).
Failed pushes are retried on later runs, max 3 attempts per lead.

## Reply tracking + CRM

Replies to Instantly campaign emails are pulled into Postgres
(`email_responses`) and drive the dashboard CRM at `/crm` (statuses, notes,
reply rate per campaign). Replying itself happens in Instantly's Unibox; the
CRM is for triage.

Setup (one-time): apply `sender-2/sql/migrations/018_add_email_responses.sql`.
The job reuses the same `INSTANTLY_API_KEY` / `INSTANTLY_CAMPAIGN_ID_*` env
vars as the lead sync.

```bash
# Pull received emails for every mapped campaign (idempotent, safe to re-run):
npm run instantly:replies

# Just one campaign:
npm run instantly:replies -- --campaign ugc_creators
```

Each received email is stored once (unique on the Instantly email id) and
attributed back to a creator via `instantly_sync` (lead email + Instantly
campaign id). Replies that can't be matched yet are stored unattributed and
matched on later runs. Run it on a schedule (e.g. every 15 minutes alongside
the other Cloud Run jobs) once campaigns are live.
