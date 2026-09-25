# Tape Load Performance Diagnostics

## Overview

This document describes the tape loading pipeline from database to UI and the diagnostic logs added to measure speed at each stage.

The tape loading flow:
```
Database (PostgreSQL) 
  ↓ [tape-load-db] query + parse time
Matching Process API (/api/matching-process/orders)
  ↓ [tape-load-orders] per-key timing + total time
Network
  ↓ [tape-serve-heartbeat] in-memory tape serving
Browser receives tape data
  ↓ [tape-ingest-ui] client-side merge + processing
Chart displays tape history
```

## Log Locations

### Browser Console
Open DevTools (F12) and filter by these log labels:

- **`[tape-load-db]`** — Database query performance
- **`[tape-serve-heartbeat]`** — Server in-memory tape serving
- **`[tape-ingest-ui]`** — Client-side tape merging

### Server Terminal
When running `npm run dev`, watch for:

- **`[tape-load-db]`** — Database query detailed metrics
- **`[tape-load-orders]`** — Per-key loading time from API
- **`[tape-serve-heartbeat]`** — Heartbeat endpoint serving time

## Diagnostic Log Formats

### Database Query: `[tape-load-db]`
```
[tape-load-db] key=EUR|spot rows=1523 window=[1234567890-1234567900] query=142ms parse=3ms total=145ms
```

**Fields:**
- `key` — Quote key (e.g., `EUR|spot`, `EUR|forward|t5.00`)
- `rows` — Number of database rows fetched
- `window` — Time range requested `[fromMs-toMs]` or `full` for unbounded
- `query` — Sequelize `findAll` duration in milliseconds
- `parse` — JSON parsing and numeric conversion time
- `total` — Total time from function entry to return

**What to look for:**
- If `query` time is > 500ms: database is slow, consider adding indexes
- If `rows` is 0 for a currency expected to have tape: no data recorded yet
- If `window` is in the past and `rows` is small: query window doesn't match recorded data

### API Endpoint: `[tape-load-orders]`
```
[tape-load-orders] email=desk@deel.com task=02 keys=2 window=[1234567890-1234567900] total=287ms per_key=[EUR|spot:142ms EUR|forward|t5.00:145ms] points=[EUR|spot:1523 EUR|forward|t5.00:1200]
```

**Fields:**
- `email` — User email (normalized lowercase)
- `task` — Task ID (typically `02` or `workspace`)
- `keys` — Number of quote keys requested
- `window` — Time range for the query
- `total` — End-to-end API response time
- `per_key` — Load time for each individual key
- `points` — Final point count per key after loading

**What to look for:**
- If `total` > 1 second for a few keys: network latency or server processing bottleneck
- If one key is much slower than others: that key's table might need an index
- If `points` is 0 but `per_key` shows non-zero time: query ran but found nothing (data loss or wrong window)

### Server Tape Serving: `[tape-serve-heartbeat]`
```
[tape-serve-heartbeat] email=desk@deel.com keys=2 tape=1ms total=34ms sizes=[EUR|spot:1523 EUR|forward|t5.00:1200]
```

**Fields:**
- `email` — User requesting tape (or `anon` if unauthenticated)
- `keys` — Number of tape keys served from runtime memory
- `tape` — Time to call `runtime.tapeForUser(email)` and build the object
- `total` — Total heartbeat response time
- `sizes` — Points per key being served

**What to look for:**
- If `tape` time is significant (>50ms): runtime has too many points in memory
- If `keys` is 0 but a ticket is open: currency not being watched or no live orders/tape yet
- If sizes are capped (exactly 600): `TAPE_SERVE_MAX_POINTS` limit is active (normal)

### Client-Side Ingestion: `[tape-ingest-ui]`
```
[tape-ingest-ui] keys=2 valid=2 total=8.2ms [EUR|spot:1523pts(2.1ms) EUR|forward|t5.00:1200pts(2.0ms)]
```

**Fields:**
- `keys` — Number of keys in the heartbeat response
- `valid` — Number of keys with valid points (filtered, non-zero)
- `total` — Total time to merge all keys into `tapeHistoryRef`
- `[key:points(time)]` — Per-key summary: total points merged and processing time

**What to look for:**
- If `total` > 20ms: filter or merge logic is slow (unlikely, indicates DOM blocking)
- If `keys` is high but `valid` is low: many keys being sent with invalid/empty data
- If a key has 0 points but was requested: server sent empty array (tape not recorded yet)

## Investigating Slow Tape Load

### Scenario: "Chart takes 5+ seconds to display tape"

1. **Check client console for `[tape-ingest-ui]`** — Is the tape arriving from the server?
   - If no log appears → tape not being sent by server
   - If log shows `total=2ms` → client is fast, issue is elsewhere

2. **Check server logs for `[tape-load-orders]`** — Is the API slow?
   - If `total` > 2000ms → database is slow
   - If per-key times vary wildly → one key has too much data, consider limiting the window

3. **Check server logs for `[tape-load-db]`** — Is the database query slow?
   - If `query` > 500ms → missing index on `leg_tape_ticks(userEmail, taskId, quoteKey, timestamp DESC)`
   - If `query` is fast but `total` is slow → parsing/merging is bottleneck (unlikely)

4. **Check server logs for `[tape-serve-heartbeat]`** — Is the heartbeat serving data?
   - If `sizes` shows 0 for all keys → no tape in runtime memory
   - If `tape` time is significant → reduce points in memory or split keys

### Scenario: "EUR tape loads but JPY doesn't"

1. **Check `[tape-load-orders]`** for both currencies
   - `EUR|spot:1523` but `JPY|spot:0` → JPY tape not recorded
   - Both show points → move to step 2

2. **Check `[tape-ingest-ui]`** 
   - `EUR|spot:1523pts` but no JPY entry → JPY data not sent by server
   - Both present → move to step 3

3. **Check when orders were placed**
   - If JPY order opened AFTER tape loading started, it might not be in the watched currencies list
   - See `[tape-serve-heartbeat]` to check if JPY is in `keys` count

### Scenario: "Chart loads empty"

1. **Check `[tape-ingest-ui]`** for `keys=0` or `valid=0`
   - If `keys=0` → server not sending tape in heartbeat
   - If `valid=0` → server sent malformed data (invalid bid/ask/mid values)

2. **Check if the order/ticket is being watched**
   - Look for `[tape-serve-heartbeat] keys=2` (or more)
   - If keys is 0 → no active orders or watched currencies

3. **Check if tape was ever recorded**
   - Run SQL: `SELECT COUNT(*) FROM leg_tape_ticks WHERE "quoteKey" = 'EUR|spot' AND "userEmail" = 'desk@deel.com';`
   - If result is 0 → matching runtime never recorded this currency

## Database Index Optimization

If `[tape-load-db]` shows `query > 500ms`, ensure this index exists:

```sql
CREATE INDEX IF NOT EXISTS leg_tape_ticks_lookup 
  ON leg_tape_ticks(userEmail, taskId, quoteKey, "timestamp" DESC);
```

Check index status:
```sql
SELECT * FROM pg_stat_user_indexes WHERE relname = 'leg_tape_ticks_lookup';
```

## Log Output Examples

### Fast path (tape already in memory via heartbeat):
```
[tape-serve-heartbeat] email=desk@deel.com keys=1 tape=0.5ms total=18ms sizes=[EUR|spot:600]
[tape-ingest-ui] keys=1 valid=1 total=2.3ms [EUR|spot:600pts(0.8ms)]
```
**Result:** Chart displays in ~2 seconds from order fill.

### Slow path (tape loaded from database on chart reopen):
```
[tape-load-db] key=EUR|spot rows=2000 window=[1234567890-1234567920] query=234ms parse=12ms total=246ms
[tape-load-orders] email=desk@deel.com task=02 keys=1 window=[1234567890-1234567920] total=251ms per_key=[EUR|spot:246ms] points=[EUR|spot:2000]
[tape-ingest-ui] keys=1 valid=1 total=18.5ms [EUR|spot:2000pts(15.2ms)]
```
**Result:** Chart displays in ~300ms from API call (acceptable).

### Missing tape (data never recorded):
```
[tape-load-db] key=JPY|spot rows=0 window=full query=45ms parse=0ms total=45ms
[tape-load-orders] email=desk@deel.com task=02 keys=1 window=full total=51ms per_key=[JPY|spot:45ms] points=[JPY|spot:0]
[tape-ingest-ui] keys=0 valid=0 total=0.2ms []
```
**Result:** Chart shows "tape did not load" message — JPY was never watched or recorded.

## Environment Variable Control

```bash
# Force all tape operations through database (not S3)
EXECUTION_STORE=postgres npm run dev

# Force through S3 (default)
EXECUTION_STORE=s3 npm run dev
```

Check which store is active:
```
[tape-load-db] key=EUR|spot db=unavailable
# ^ Database not available, falling back to S3
```

## Troubleshooting Checklist

- [ ] Server logs show `[tape-load-db]` with reasonable query times (< 500ms)?
- [ ] API logs show `[tape-load-orders]` returning tape data (points > 0)?
- [ ] Browser console shows `[tape-ingest-ui]` with valid points count?
- [ ] Chart is watching the currency (appears in `[tape-serve-heartbeat] keys` count)?
- [ ] If slow, is the bottleneck in query (database) or parse (unlikely)?
- [ ] If no tape, check if `leg_tape_ticks` table has any rows for this currency/user?

## Option / ticket pricing: `[price-perf]`

Option premium is **not** an API call. It is synchronous browser math, and
`/api/price` (Refinitiv) is not on this path. So pricing cost shows up in the
browser console, never in the server terminal.

The profiler is throttled to one line per 5s, because the pricing memos re-run
at 1 Hz and an unthrottled log would dominate the frame it is measuring.

```
[price-perf] window=5.0s busy=2840ms (56.8% of wall)
  pad: 5x avg=12.4ms max=31.0ms sum=62ms (forward 2 sides)
  optionCharts: 5x avg=486.0ms max=612.0ms sum=2430ms (ticket instrument=forward)
  stripQuotes: 5x avg=69.6ms max=98.0ms sum=348ms (6 legs x 2 sides)
```

**Fields:** `runs` in the window, `avg` / `max` per run, `sum` total busy ms.
`busy%` is the share of wall-clock the main thread spent pricing — over ~30%
means the UI is visibly janky.

**Stages:**

| Stage | What it covers | Normal |
|---|---|---|
| `pad` | The main tile: `simulateTicketPrice` × 2 sides (3 on mid) | < 15ms |
| `optionCharts` | `sampleOptionMarketCharts` — payout curve + premium surface | the expensive one |
| `stripQuotes` | Per-leg strip pricing, N legs × 2 sides | scales with legs |

### The 1 Hz amplifier

`pullLiveSpot` polls `/api/fx-spot` on a 1000ms interval
([TradeTicketPanel.tsx:1855-1861](fx-test-project/components/test-mode/TradeTicketPanel.tsx#L1855-L1861))
and bumps `repriceTick` in its `finally`. `repriceTick` is a dependency of all
three memos, and each opens with `void repriceTick`. **Every pricing stage
above therefore re-runs once a second whether or not any pricing input
changed.** A high `runs` count with a low input-change rate is this, not real work.

### Known defect the profiler makes visible

`optionCharts` hardcodes `instrument: 'option'` and `instrument` is **not** in
its dependency list
([TradeTicketPanel.tsx:2674-2707](fx-test-project/components/test-mode/TradeTicketPanel.tsx#L2674-L2707)),
while its consumer is gated on `optionDesk`. So on a spot or forward ticket it
still builds the full 257-node payout curve and the premium surface every
second, and nothing reads the result.

Confirm it from the log: a line reading
`optionCharts: 5x avg=486.0ms ... (ticket instrument=forward)` is pure waste —
`instrument=forward` means no option chart is on screen.

### Cost drivers inside the option pricer

Ranked, with file references:

1. **`optionPayoutCurve`** — [sim-ticket-price.ts:628-676](fx-test-project/lib/test-mode/sim-ticket-price.ts#L628-L676).
   257 grid nodes, one `priceVanilla` per node, each allocating a `decimal.js`
   object plus 2 `normCdf` + 1 `normPdf`. ≈257 Decimal allocations and ~770
   `erf` evaluations per run.
2. **`buildPremiumSurface`** — [sim-ticket-price.ts:1114-1166](fx-test-project/lib/test-mode/sim-ticket-price.ts#L1114-L1166).
   tenors × deltas nested loop. Per cell it calls `resolveCurveOutright` →
   `interpolateSwapPoints` → `swapPointsTenorCurve`
   ([fx-market-rates.ts:412-443](fx-test-project/lib/fx-market-rates.ts#L412-L443)),
   which **re-sorts the whole deposit curve on every cell**. The final
   `zipped.sort` calls `medianStrike` inside the comparator, which itself
   maps+filters+sorts per invocation.
3. **Vol surface layout rebuilt per lookup** — [sim-ticket-price.ts:951-1047](fx-test-project/lib/test-mode/sim-ticket-price.ts#L951-L1047).
   `volFromSurfaceAtSignedDelta` rebuilds `surfaceTenorYLayout` fresh each
   call, regex-parsing every axis label. On a 12-leg strip that is ~96 full
   surface re-parses per second.

There is **no** Monte Carlo and **no** implied-vol root-finding — the
delta→strike inversion is closed form. The cost is repetition × allocation.

### Reading the profile

- `optionCharts` dominant **and** `instrument=forward`/`spot` → the ungated
  memo above; gating it is the single biggest win.
- `stripQuotes` dominant → scales with leg count; check `N legs` in the note.
- All three roughly equal and `runs` ≈ window seconds → the 1 Hz tick is
  driving everything; memo inputs are not actually changing.
- `busy%` under ~10% → pricing is not your bottleneck, look at the chart
  render or the candles fetch instead.

## Related Code

- Server tape loading: `lib/test-mode/matching-process-persist.ts` → `loadLegTapeTicks`
- API endpoint: `app/api/matching-process/orders/route.ts`
- Heartbeat serving: `lib/test-mode/matching-process-runtime.ts` → `tapeForUser`
- Client ingestion: `components/test-mode/HedgingDecisionLayer.tsx` → `ingestServerTape`
- Database model: `lib/db/models/leg-tape-tick.ts`
- Day-record candles: `lib/fx-spot-tape.ts` → `spotDayCandlesFor` (`[candles-load]`)
- FX Atlas frontier: `lib/test-mode/fx-atlas-job.ts` → `computeFxAtlasJob` (`[quant-fx-sigma] timing`)
- Ticket pricing profiler: `components/test-mode/TradeTicketPanel.tsx` → `notePriceStage` (`[price-perf]`)

## Day record candles: `[candles-load]`

```
[candles-load] pair=EURUSD bar=60s lane=412 out=398 seed=2980ms backfill=41ms assemble=2ms total=3023ms persisted=true
```

`seed` is a blocking call to the external spot provider, paid **only when this
process has no walk for the pair yet** — i.e. the first chart open after a
server restart. That is the 3.3s first load; subsequent reads showed ~340ms.
If `seed` is 0 and `total` is still high, the cost is `backfill` (Postgres) —
check the index note above.

## FX Atlas frontier: `[quant-fx-sigma] timing`

```
[quant-fx-sigma] timing legs=38ms frontier=61ms marginal=9ms compute=108ms (logging not yet counted)
[quant-fx-sigma] sweet (Recommended): ... 441ms total (logging 333ms)
```

The endpoint emits ~90 synchronous `console.log` lines on a 72-leg book, and a
TTY write blocks. Compare `compute` against `logging`: if logging dominates,
the solver is fine and the fix is to drop `{ log: true }` in
`app/api/test/quant-fx-sigma/route.ts`, not to optimise the maths. The first
request of a session also pays Next.js route compilation (~750ms) on top —
that is a dev-only cost and is not in these numbers.

## References

- Full tape architecture: `docs/handover-spot-tape.md` and `docs/handover-order-execution-tape.md`
- `TAPE_SERVE_MAX_POINTS` constant in `matching-process-runtime.ts` (default 600)
- `MAX_TAPE_POINTS_PER_KEY` constant in `matching-process-persist.ts` (default 1800)
