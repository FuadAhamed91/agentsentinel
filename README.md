# AgentSentinel

Persistent monitoring for XDC price, gas and wallet balances, sold to AI agents on the
XDC AI marketplace (x402, USDC). An agent creates a watch ("XDC price above 0.08"), then
calls `/check` whenever it wants an update. The server samples in the background every
15 seconds, so each check reports everything since that watch was last checked,
including moves that happened and reversed between checks.

The service is a plain HTTPS JSON API. The XDC AI Gateway sits in front of it, shows the
agent the 402 challenge, verifies the payment, forwards the call, and settles on-chain
only when this server answers 2xx. There is no payment code here.

| Route | Price (USDC) | Purpose |
|---|---|---|
| `POST /watch` | 0.02 | Create a watch. Returns `watch_id` and a secret `watch_token`. |
| `POST /check` | 0.01 | `{ "watch_tokens": [...] }` (1 to 50). Report for each watch since its last check. |
| `GET /info` | free | Watch types, conditions, prices, example bodies, field definitions. |
| `POST /watches` | free | Configuration and lifecycle status of each watch. |
| `POST /events` | free | Triggers already reported by `/check`. |
| `POST /cancel` | free | `{ "watch_token": "..." }` or `watch_tokens`. Cancels watches. |
| `GET /health` | free | Liveness and source freshness. |
| `GET /stats?key=...` | not listed | Operator page (active watches, checks today, distinct tokens). |

Prices, routes, tags and capability text live in one file, [src/catalog.js](src/catalog.js).
The server registers its routes from it, `/info` reports prices from it, and
`npm run gateway` writes `gateway.json` from it. A test fails if `gateway.json` and the
catalog disagree.

## Watch types

| type | unit | conditions | source |
|---|---|---|---|
| `xdc_price` | USD | above, below, crosses_above, crosses_below, changes_by_percent | Kraken `XDCUSD` last trade; fallback CoinGecko `xdce-crowd-sale`, Coinpaprika `xdc-xdc-network` |
| `xdc_gas` | gwei | above, below | `eth_gasPrice`, XDC mainnet RPC (chain 50) |
| `wallet_balance` | XDC | above, below, changes | `eth_getBalance`, XDC mainnet RPC; `xdc…` or `0x…` addresses |

Trigger rules:

- **above / below**: holds while value > threshold (or < threshold). One trigger each time the value moves into that state. A condition already true when the watch is created counts as one trigger (`met_at_creation`).
- **crosses_above / crosses_below**: trigger when the previous sample was at or below (at or above) the threshold and the next sample is past it.
- **changes_by_percent**: `percent` > 0, `direction` any, up or down. Measured from a reference value: the value at creation, reset to the current value at every check.
- **changes** (wallets): trigger whenever the exact balance in wei differs from the previous sample, including a return to an earlier balance.

`triggered` in a check is true when at least one trigger happened since the previous check,
or when an above, below or changes_by_percent condition holds right now.

Each type is its own module in [src/types/](src/types/) with the same interface
(`sourceKey`, `fetchSamples`, `evaluate`). Add a type by writing one module and listing it
in [src/types/index.js](src/types/index.js).

## Run locally

Node.js 20 or newer.

```bash
npm install
npm start
```

With no `.env` the server listens on port 8080, stores data in `./data/agentsentinel.sqlite`
(SQLite through sql.js, no native build), and leaves paid routes open because
`GATEWAY_SECRET` is empty. Copy `.env.example` to `.env` to set anything.

```bash
npm test                 # all tests: mocked sources, in-memory SQLite
npm run live-check       # hits every real price API and RPC endpoint once
npm run gateway          # regenerate gateway.json from src/catalog.js
```

To run the tests against Postgres (they wipe the tables of that database):

```bash
TEST_DATABASE_URL=postgres://user:pass@host:5432/dbname npm run test:pg
```

## Deploy on Replit

1. **Get the code into a Replit App.** Push this folder to a GitHub repository and use
   *Create App → Import from GitHub*, or create a Node.js app and upload the files
   (everything except `node_modules`, `data` and `.env`). `.replit` is included: it runs
   `npm start` on port 8080 and installs dependencies with `npm ci` when publishing.
2. **Create the database.** Open the *Database* tool and create a PostgreSQL database.
   Replit adds `DATABASE_URL` to the app's secrets. The tables are created automatically
   at startup.
3. **Add secrets** (*Secrets* tool):
   - `GATEWAY_SECRET`: a long random string, for example the output of
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `STATS_SECRET`: another random string.
4. **Run it in the workspace** and open `/health`. It should show `"database":"postgres"`
   and a price and gas value within about 20 seconds.
5. **Publish as a Reserved VM.** *Publish → Reserved VM → Web server*, run command
   `npm start`. Do not use Autoscale: it stops the process when no requests arrive, which
   stops the sampler, and moves between checks would be missed. If the publish flow
   offers a production database, accept it; the schema creates itself. Check that the
   published app has `DATABASE_URL`, `GATEWAY_SECRET` and `STATS_SECRET`.
6. **Check the published app:**
   ```bash
   curl -s https://YOUR-APP.replit.app/health
   ```
   Then open `https://YOUR-APP.replit.app/stats?key=YOUR_STATS_SECRET`. The *database*
   row must say `postgres`; on SQLite every restart loses all watches.

## List it on the XDC AI Gateway

1. Create the import file with the real URL and secret (keep this file private, it is
   git-ignored):
   ```bash
   PUBLIC_BASE_URL=https://YOUR-APP.replit.app GATEWAY_SECRET=the-same-secret npm run gateway:import
   ```
   This writes `gateway.import.json`. Alternatively edit a copy of `gateway.json` by hand:
   replace `upstreamBaseUrl` and `auth.secret`.
2. Sign in at https://xdcai.tech/gateway. In *Settings*, set your **payTo** wallet address
   (where USDC arrives) and enable **XDC Mainnet**.
3. Click **Import JSON** and paste or upload `gateway.import.json`. The file sets
   `isPublic: true`, so the service is listed as soon as it is imported. Note the service
   id (`gw_…`) on the service page.
4. Optional: add secret `GATEWAY_PUBLIC_URL=https://api.xdcai.tech/x402/connect/gw_…` and
   republish; direct calls to paid routes then get that URL in their 401 body.
5. Verify the gateway reaches the server through a **free** route:
   ```bash
   curl -s https://api.xdcai.tech/x402/connect/gw_YOUR_ID/info
   ```
   Then reload `/stats`: `gateway_requests_since_start` must have increased and
   `requests_with_wrong_bearer_since_start` must be 0 (otherwise the secret in the gateway
   differs from `GATEWAY_SECRET`). `gateway_header_names_seen` lists the headers the
   gateway forwards; after the first paid calls, look there for a payer address header.

Do not call the paid routes through the gateway from your own wallets or agents.
Self-dealing is excluded from the prize.

## curl examples

Run these in the Replit Shell or any bash shell. Locally, the `Authorization` header is
only needed when `GATEWAY_SECRET` is set; through the gateway it is added by the gateway.

```bash
BASE=http://localhost:8080
AUTH="Authorization: Bearer $GATEWAY_SECRET"

curl -s $BASE/info
curl -s $BASE/health

# create watches (paid: 0.02 each through the gateway)
curl -s -X POST $BASE/watch -H "$AUTH" -H 'content-type: application/json' \
  -d '{"type":"xdc_price","condition":"above","threshold":0.08}'
curl -s -X POST $BASE/watch -H "$AUTH" -H 'content-type: application/json' \
  -d '{"type":"xdc_price","condition":"changes_by_percent","percent":5,"direction":"any"}'
curl -s -X POST $BASE/watch -H "$AUTH" -H 'content-type: application/json' \
  -d '{"type":"xdc_gas","condition":"above","threshold":20}'
curl -s -X POST $BASE/watch -H "$AUTH" -H 'content-type: application/json' \
  -d '{"type":"wallet_balance","address":"xdc0000000000000000000000000000000000000088","condition":"changes"}'

# check one or many (paid: 0.01 per request)
curl -s -X POST $BASE/check -H "$AUTH" -H 'content-type: application/json' \
  -d '{"watch_tokens":["wt_...","wt_..."]}'

# free routes
curl -s -X POST $BASE/watches -H 'content-type: application/json' -d '{"watch_tokens":["wt_..."]}'
curl -s -X POST $BASE/events  -H 'content-type: application/json' -d '{"watch_tokens":["wt_..."]}'
curl -s -X POST $BASE/cancel  -H 'content-type: application/json' -d '{"watch_token":"wt_..."}'
```

How an agent calls it through the marketplace:

```bash
npx xdcai call "https://api.xdcai.tech/x402/connect/gw_YOUR_ID/watch" --method POST \
  --data '{"type":"xdc_price","condition":"above","threshold":0.08}'
```

A `/check` result for a watch whose price went above 0.08 and came back (abridged):

```json
{
  "index": 0, "status": "active", "watch_id": "w_Gg9Ty8g8FcB6",
  "type": "xdc_price", "condition": "above", "threshold": 0.08, "unit": "USD",
  "current_value": 0.07, "current_value_time": "2026-10-05T12:00:45.000Z",
  "current_value_source": "kraken", "stale": false,
  "triggered": true, "condition_met_now": false,
  "trigger_count_since_last_check": 1,
  "triggers_since_last_check": [
    { "time": "2026-10-05T12:00:30.000Z", "kind": "moved_above", "value": 0.085, "previous_value": 0.075 }
  ],
  "triggers_not_listed": 0,
  "high_since_last_check": 0.085, "low_since_last_check": 0.07, "sample_count_since_last_check": 3,
  "previous_check_time": null, "seconds_since_last_check": 45, "sample_interval_seconds": 15
}
```

## Behaviour notes

- **Errors:** invalid input gets a 400 with `error`, `message`, `field` and example bodies,
  so the caller is not charged. Unknown, cancelled, expired or duplicate tokens are reported
  per item inside a 200. Internal errors give a plain 500 with no stack trace.
- **Stale data:** a value is never invented. If a source fails, responses still return
  200 with the last known value, its timestamp and `"stale": true`. The newest sample of
  every series is kept even past the 48 hour retention.
- **Shared sampling:** one price request, one gas request and one batched balance request
  per round, whatever the number of watches. Wallets are sampled only while an active
  watch exists. The sampler only reads public sources. It never calls this service's routes
  and never creates payments.
- **One sampler:** a lease row in the database lets exactly one process sample, even if
  more than one instance runs. A cleanly stopped process releases it at once. After a
  crash the lease expires in 45 seconds, so sampling resumes within about a minute.
- **Rate limits:** per watch token (60 `/check` requests per minute by default) and per IP
  for direct traffic (120 per minute). Gateway traffic all comes from the gateway, so it is
  limited per token rather than per IP. A 429 means the caller is not charged.
- **`/events` and `/watches` are free**, so they never reveal triggers that `/check`
  has not reported yet. Otherwise the paid check could be skipped.
- **Watches** expire after 30 days (`WATCH_TTL_DAYS`).
- **Tables:** `watches`, `samples`, `checks`, `events`, plus a one-row `sampler_lease`.

## Files

```
src/catalog.js          routes, prices, tags, capability text (single source of truth)
src/server.js           entry point (npm start)
src/bootstrap.js        wires database, store, sampler and HTTP app
src/app.js              HTTP routes, gateway auth, rate limits, error handling
src/sampler.js          shared background sampler and leader lease
src/conditions.js       trigger rules (pure functions)
src/store.js            all SQL; atomic check and evaluation
src/types/*.js          xdc_price, xdc_gas, wallet_balance modules
src/sources/*.js        price APIs and XDC JSON-RPC client with failover
src/db/*.js             Postgres (DATABASE_URL) and SQLite (sql.js) adapters, schema
src/stats.js            plain /stats page
src/gateway-listing.js  builds the gateway service JSON
scripts/gen-gateway.js  writes gateway.json / gateway.import.json
scripts/live-check.js   live request to every data source
test/*.test.js          node:test suites
```
