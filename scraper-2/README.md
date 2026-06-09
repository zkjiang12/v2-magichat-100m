# MagicHat Instagram Scraper

This codebase has five main workflows:

- `eval:accuracy`: compare your 1-4 creator scores against AI scores.
- `eval:speed-cost`: benchmark a standard 250-profile run from `@yestheory`.
- `crawl`: run the actual frontier crawler.
- `dashboard:legacy`: inspect old local JSON crawl/evaluation results.
- `review`: run one-off manual handle checks.

## Setup

```bash
cp .env.example .env
npm install
```

Fill in `.env` with the required API keys.

## Accuracy Eval

Add handles and your scores to:

```text
evals/gold/accuracy.json
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
data/eval-runs/accuracy/
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
DATABASE_URL='postgresql://...' npm run crawl -- --file seeds.txt --following-limit 2000 --qualification-workers 32 --max-accepted 100
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
