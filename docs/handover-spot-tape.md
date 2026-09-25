# Handover — spot-only TP/SL matching on a server-owned tape

> Written 2026-09-07. Covers the work merged into `dev` as `7eafef8` (feature)
> and `b99b707` (review fixes), merge point `b12332c`.
> Purpose: let a session on another machine pick this up without re-deriving it.

---

## 1. What the feature is

TP/SL bracket orders reference **spot**, never the forward outright, and the
**server matching runtime is the single source of truth** for the tape those
orders are monitored, filled, persisted and verified against.

Before this change there were two independent random walks — one in the browser
driving the chart, one in the Node matcher deciding fills — so a fill could be
"consistent" against one and unexplainable against the other. That divergence
was the root cause behind "the chart doesn't justify this fill".

### The load-bearing pieces

| Concern | Where |
|---|---|
| Tape identity | `tapeQuoteKey` in `lib/test-mode/tape-candles.ts` — returns canonical `CCY|spot` for every spot-instrument ticket; forwards keep `CCY|forward|tX.XX` / `|sN` |
| Live anchor | `lib/fx-spot-tape.ts` (process-global walk map, 20s fetch cache) fed by `lib/fxLiveClient.ts`; walk between real prints in `lib/test-mode/stale-live-walk.ts` |
| Matcher | `lib/test-mode/matching-process-runtime.ts` — `pullSharedSpotTape` pins spot keys to the live series each 1s beat; `applyMatches` looks up `quotes.get(tapeQuoteKey(t))` |
| Trigger guard | `restingOrderTriggersAt` in `lib/test-mode/hedge-var.ts` — refuses a fill when the quote is the wrong convention for the order |
| Persistence | `LegTapeTick` (Postgres, keyed by quoteKey+user+task) and the S3 execution journal, both via `lib/test-mode/matching-process-persist.ts` |
| Serving to UI | `runtime.tapeForUser()` → `tape` field on `/api/matching-process/heartbeat` and `/orders` |
| UI ingest | `ingestServerTape` in `components/test-mode/HedgingDecisionLayer.tsx`; the browser's own walk stops writing chart points while the server owns fills |
| Idempotency | `consumed_order_keys` table (`lib/db/models/consumed-order-key.ts`), reloaded on runtime start |
| Day record (pre-trade chart) | `lib/fx-spot-tape.ts` folds every walk commit into 1m OHLC bars per pair (`spotDayCandlesFor`), upserted to `spot_day_candles` (`lib/db/models/spot-day-candle.ts`, not user-scoped — one market feed per currency); served by `GET /api/fx-spot/candles`; drawn by `components/test-mode/SpotDayChart.tsx` as the ticket's **Day** view (1m / 5m / 15m). Each bar counts its live prints vs simulated steps (`prints` / `ticks`). Rows older than 7 days are pruned hourly. The matcher beat also refreshes a stale live print — every 20s while a ticket, chart or resting order is interested in the pair, every 5 min otherwise — so the record follows the market with no ticket open (REV 39 after the merge with the watched-currency recording) |

### The two rules that keep it correct

1. **Keying is the whole game.** Every layer derives its key from
   `tapeQuoteKey`. An earlier attempt at spot referencing was reverted because
   it changed client-side anchors while the matcher still looked up the
   outright key, which silently made every forward-leg bracket unfillable.
   Never change one side alone.
2. **The canonical spot key is a market feed.** Orders may *seed* a missing
   spot key from their stamped spot, but never re-anchor or veto an existing
   one. Order stamps are placement-time values; letting them steer the feed
   froze the tape while the market moved away, and let a single wide order
   blank the feed for a whole currency.

Verified end to end in a real session: a spot take-profit at 1.16300 filled at
bid 1.16305 when the spot tape crossed it, while a 1M forward outright print at
1.16430 correctly did **not** trigger it. That non-fill is the feature, not a
bug — outright prints sit ~14 pips above spot at that tenor.

---

## 2. Open issues, ranked

> Checked and closed, do not re-open: `ipaQuote.fxOutright` holding the fill
> price on a **spot** fill is not a name reuse. `sim-ticket-price.ts`'s pricing
> path already sets `outright = spot.mid` for a spot instrument, so the field
> means "the all-in traded rate of this instrument" on both the pricing and the
> fill side — and a spot trade *is* an outright, at the spot date. Renaming it
> would touch ~40 read sites and contradict the pricing path.

1. ~~40-pip resting-distance cap~~ **RESOLVED 2026-09-08, by product
   decision: removed for orders.** `restingOrderTriggersAt` no longer
   distance-vetoes — a TP/SL rests at any distance and fills when its own
   tape crosses it (a stop already through the quote fills immediately
   instead of dying silently). `TAPE_MAX_JUMP_PIPS` and
   `quoteIsWrongTapeForOrder` remain in force on the FEED side only
   (runtime key gates, chart continuity) — do not remove those.
2. Mount-time race: the journal load can briefly discard freshly ingested
   server points; self-heals on the next 2s poll.
3. Tape recorded under retired spot key formats (`EUR|spot|1m`, `|s0`) is
   pruned on load, not migrated — pre-change chart history starts fresh.
4. No incremental paging of the served tape (600 points per key on every 2s
   poll); no `since` cursor yet.
5. If heartbeat polls fail outright while the server still owns fills, the
   chart can stall — the local walk is gated off by design.
6. Pre-existing, not introduced here: `[fx-exec]` stdout lines carry rates,
   notionals and owner emails (violates `check-financial.md` §6 — deserves its
   own ticket); `MatchingEngine.tapeHistory` grows uncapped; stale GTC forwards
   (MXN/PLN/TRY 1y) rehydrate on every restart and should be cancelled from the
   blotter; four hook/script test suites fail at load with a SyntaxError; and
   `fx-pre-push` step 3's "four expected `tsc` errors" baseline is **stale** —
   the typecheck is fully green now.

   > **Update 2026-09-08.** Two items in the list above were fixed after this
   > was written and are no longer true. The four hook/script suites pass:
   > `npx vitest run .claude .cursor` → 4 files, 239 tests, all green. And the
   > `fx-pre-push` step 3 baseline has been deleted, so step 3 is now a plain
   > "zero errors". The rest of the list still stands.

---

## 3. Environment on a new machine

`.env.local` is gitignored — copy it across by a secure channel, do not commit
it. `.env.example` lists every variable and `README.md` documents them.

**Local Postgres is required** for the DB-backed tape and consumed-key tables
(the app degrades to S3/localStorage without it, which hides exactly the
behaviour this feature is about). There is no Postgres service on the previous
machine either — it runs as a portable install:

```
# download + unzip the PostgreSQL 17.4 Windows binaries, then once:
<pgsql>\bin\initdb -D <data> -U postgres --auth=scram-sha-256 --pwfile=<file> -E UTF8
<pgsql>\bin\pg_ctl -D <data> -l <data>\..\postgres.log -o "-p 5432" start
<pgsql>\bin\createdb -h localhost -U postgres fx_test_project
```

Then set `DATABASE_URL=postgres://postgres:<pw>@localhost:5432/fx_test_project`
in `.env.local`. Tables are created by the app on first use (`sync()`, no
force/alter). It is **not** a service — start it again after each reboot.

### Two operational traps that cost real time here

- **OneDrive locks `.next`.** It produces `EBUSY`/`ENOENT` errors and silently
  breaks hot reload, so the server keeps executing *stale matcher code* while
  the UI shows fresh prices. This is what "the rate isn't changing" turned out
  to be. Exclude `.next` from OneDrive sync, and restart the dev server after
  any change to the matching runtime.
- **Never run two dev servers against one checkout.** They share `.next` and
  corrupt each other's build. Check who owns port 3000 first.
- `MATCHING_RUNTIME_REV` in `matching-process-runtime.ts` must be bumped
  whenever matcher fill/tape behaviour changes, or HMR keeps the old singleton
  alive.

---

## 4. How to verify it still works

```bash
npm test                     # 2119 passing, 16 skipped, 0 failing (2026-09-08)
npx tsc --noEmit             # green — zero errors
npx vitest run .claude .cursor   # guard + script suites: 4 files, 239 tests
```

In the app: leave a spot TP/SL (or OCO) on EUR within ~40 pips of market, then

- the ticket tape chart shows the server's `EUR|spot` series,
- the terminal logs `leg tape DB persist ok: N points, keys=EUR|spot,…`,
- fills arrive from the matcher at a price on that same series.

Confirm persistence directly:

```sql
select "quoteKey", count(*), min(mid), max(mid) from leg_tape_ticks group by 1;
select "orderId", price, fill from order_executions order by "executedAt" desc limit 5;
select pair, count(*), min("bucketStartMs"), max("bucketStartMs") from spot_day_candles group by 1;
```

`POST /api/test/verify-strip-legs` replays `restingOrderTriggersAt` against the
recorded tape and reports any fill the tape does not justify.

---

## 5. Reviews already done

Two independent review passes (`fx-review` brief, separate agent, Opus-class)
ran over this change. Round 1 returned 13 findings, round 2 returned 14
including one CRITICAL — an unauthenticated caller could read every desk's
working levels and notionals from the heartbeat endpoint. All CRITICAL and HIGH
findings are fixed; the remainder are the list in section 2. Re-reviewing the
same diff is not a good use of time; the open items above are what needs
decisions.
