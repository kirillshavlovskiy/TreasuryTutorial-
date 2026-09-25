# Handover — order submission, execution, and the tape record chart

> Written 2026-09-09, covering the work on `dev` from `f07d8db` through `82833c2`.
> Sibling to `docs/handover-spot-tape.md`, which covers the layer underneath:
> how TP/SL brackets came to reference spot and why the server owns the tape.
> Read that one first if the matching runtime is new to you.
>
> This document is about what sits **on top** of that: how an order gets
> submitted and executed, and how the chart tells the story of what happened.

---

## 1. The model, stated once

Three ideas carry almost everything here. Every bug in section 3 is one of
them being violated somewhere.

### One recorded tape per currency

There is exactly **one** persisted series per currency: `CCY|spot`. Forward
legs do not have their own tape. A forward leg's chart is **derived** at
render time — the spot history, shifted by that leg's stamped points
(`ipaQuote.fxOutright − ipaQuote.fxSpot`).

Matching and execution happen at spot level. Forward keys still carry a
*live* quote so the matcher can trigger on them (live spot plus stamped
points), but they write no history.

Consequences that are easy to forget:

- A forward leg with no stamps has no derivable chart. The fallback is its
  own legacy key, which under spot-only storage is almost always empty.
- If a leg's stamps are wrong, its chart is wrong by exactly that error, and
  it looks like a *charting* bug when it is a *booking* bug. This happened —
  see `2ef4788` in section 3.
- `storyTapeKey(ticket)` maps any non-spot ticket to `${ccy}|spot` for
  persistence attribution and serving. Anything that walks tickets to decide
  what to record or serve must go through it.

### The chart is an order's story, not a market feed

A booking's chart is bounded. It runs from when the order's story starts to
its execution plus a guaranteed post-fill tail (`POST_FILL_TAPE_TAIL_MS`,
180s). It is not "the last N minutes of the market".

Where the story starts depends on how the order came to exist, and this
distinction is load-bearing:

| Order kind | Story starts at | Why |
|---|---|---|
| Rested (limit filled, working limit, cancelled) | placement, decoded from the ticket id | The id is minted when the order is placed |
| Market (live click) | the moment the ticket panel opened | There is no placement — the id was minted when the *card* was composed, often long before |

Getting this wrong is not subtle: a market execution anchored on its id
decode showed fifteen minutes of pre-interaction feed.

A working order's chart runs to the current moment. An executed one is
frozen at fill plus tail.

### Recording starts when the desk engages, not when an order exists

The server records a currency's spot tape while *anything* references it:
an open ticket panel, a working order, or a fill still inside its tail.

The open-panel case is the one that is easy to miss and was missing until
`47b0d8d`. A market execution creates its order **at the fill**, so if
recording only follows orders, there is by construction nothing recorded
before any live execution — the chart can only ever start at its own fill
print. Watched currencies close that hole.

---

## 2. How the pieces connect

```
desk opens ticket ──► watchCcys (heartbeat, 2s, TTL 30s)
                              │
order placed / filled ────────┼──► runtime records CCY|spot each beat
                              │         │
fill + 180s tail ─────────────┘         ├──► LegTapeTick rows (Postgres)
                                        └──► tapeForUser → heartbeat `tape`
                                                    │
                                    ┌───────────────┴───────────────┐
                                    ▼                               ▼
                        in-memory tapeHistoryRef            Postgres backstop
                        (live, seconds old)                 GET /orders?keys&fromMs&toMs
                                    │                               │
                                    └───────────┬───────────────────┘
                                                ▼
                                   legTapeHistory prop (always
                                   carries CCY|spot)
                                                ▼
                              seedTrailForSelectedLeg
                              spot history + stamped points
                                                ▼
                                     clipToStory (story window)
                                                ▼
                                          the chart
```

Two independent paths feed the chart on purpose. The in-memory map is fast
but only covers what the heartbeat served since this page load; the Postgres
backstop covers everything else — a reopened booking, a runtime restart, a
key the heartbeat stopped serving. Neither alone is sufficient.

### Where things live

| Concern | File |
|---|---|
| Tape identity (`tapeQuoteKey`, `storyTapeKey`) | `lib/test-mode/tape-candles.ts`, `matching-process-runtime.ts` |
| Recording, serving, watched currencies | `lib/test-mode/matching-process-runtime.ts` |
| Story window, seeding, markers, pad gating | `components/test-mode/TradeTicketPanel.tsx` |
| Backstop fetch, book state, cancellation | `components/test-mode/HedgingDecisionLayer.tsx` |
| Fill-rate rules for strips | `lib/test-mode/click-trade-pad.ts` |
| Removal semantics | `lib/test-mode/rolling-hedge.ts` |
| Chart-load capture sink | `app/api/tape-load/route.ts` |

---

## 3. What was actually broken, and what it teaches

This is the useful part. Each of these looked like a different bug and
several looked like charting bugs while living somewhere else entirely.

### Attribution by array position

`stripFills` mapped fills to legs by **position in the fills array**, and
`stampLiveFillOnStripTickets` looked them up by `stripEdgeIndex`. Those two
coincide only while every leg fills. The moment a partially-executed strip
fills just its open rows, every leg gets its neighbour's rate.

It was latent for as long as strips only ever filled whole. Fixed in
`353db35` by keying off the row's own edge index.

**Lesson:** an index into a filtered array is not an identity. If a value
means "leg 3", carry "leg 3", not "the third one I happened to process".

### Guards that outlived their design

Two separate cases, same shape:

- `isCurrentOverlayTapeFill` decided whether a fill could be drawn by
  comparing it to **when the overlay opened**, dropping anything more than
  5s older. Written when a chart was a live feed and an old fill on it was
  noise. Once the chart became a *record of a past execution*, this hid the
  fill pin and every tag on every booking reopened after it filled — which
  is every reopened booking. Fixed in `29b4c76`: the drawn series is now the
  authority; the overlay window is only a fallback before anything is drawn.

- `hedgeTicketsRemovedBy` swept every ticket sharing a `stripId`, filled
  ones included, so cancelling a strip erased executed trades and published
  false CANCELLED events for them. Fixed in `763ae51` — then that fix
  overreached and made filled tickets unremovable *at all*, breaking book
  cleanup, corrected in `c0dc0d5` by keying on the **targeted** ticket:
  cancelling a working leg spares filled siblings, explicitly cancelling a
  filled ticket still removes it.

**Lesson:** when the meaning of a surface changes, its guards need
re-deriving, not preserving. And a guard written to prevent one wrong thing
will happily prevent the right thing if you only test the direction you were
worried about.

### Memoisation that outlived its window

The Postgres backstop memoised its read **per key per mount**. With the
panel open before an execution, it ran once with window `[now, …]`, got
nothing, and marked the key done — so it never re-read after the fill
defined a real window. The ticks sat in Postgres until a page reload.

Fixed in `47b0d8d`: the memo keys on key **and** window, and an empty
response releases the key instead of retiring it.

**Lesson:** memoise on everything the request depends on. A cache keyed on
less than its inputs is a correctness bug waiting for the inputs to change.

### React identity churn as a performance *and* correctness bug

The leg reseed effect depended on the `legTapeHistory` **object**, which the
parent rebuilds every render. The effect ran on every heartbeat, re-merged
points the live-append path already handled, and re-rendered the chart
continuously — plus one `[tape-load]` line and POST every 2s.

Fixed in `5323d64` with a **content signature** (first timestamp per key),
because what the reseed actually exists for is history arriving *earlier*
than what the trail has, which always moves a series' first point. Tail
growth never triggers it.

**Lesson:** a dep that changes identity every render is not a dependency,
it's a timer. Depend on the content you actually react to.

### Gating a whole surface when only part of it is done

A booking reopened from the book was read-only in full. But a strip is only
finished when every leg has executed **or** has an order working; legs that
are neither are still the desk's to trade. `353db35` unlocks exactly those,
while everything already done stays view-only and ladder reshaping stays
locked.

The same commit closed the hole this exposed: the all-legs pad fill mapped
*every* row, so a second click would re-trade filled legs and overwrite
their original executions.

**Lesson:** "is this thing finished" is usually a per-part question. And the
moment you let someone act on a partially-complete object, re-entrancy
becomes real — check what a second click does.

### A synthetic identity used as a lookup key

`composeDecisionBookTicket` mints a **fresh** `stripId` whenever Book opens
as a strip. Nothing on the book carries that id. The panel's peer supply
then narrowed strip peers to `t.stripId === draft.stripId`, matched
nothing, and handed the panel an empty peer list — so every leg opened as
unexecuted. Opening as a *bullet* mints no stripId, skipped the gate
entirely, and resolved correctly; that asymmetry was the whole bug and the
reason it looked like a status-fetching problem.

**Lesson:** an identity you mint for a not-yet-real object is not a key you
can look real objects up by. Either don't mint it until the object exists,
or never use it as a join key — check that it resolves first.

### Widening a filter is not the fix for starvation

The first correction supplied **every** strip ticket for the currency. That
un-starved the panel and immediately produced a worse failure: EUR had three
strips on the book, so rows matched peers from a different ladder — the
priced-legs list showed two legs sized like the *brackets* of one strip
while the blotter listed a 4.05M forward from another.

The right answer is exactly one strip: the draft's own when it is on the
book, else the currency's most recently active one.

**Lesson:** "too narrow" and "too wide" are both wrong. When a filter
starves, define the correct set explicitly rather than removing the
constraint — an empty result and a mixed result fail differently, and the
mixed one is harder to see because it renders plausibly.

### A label that decides which renderer draws you

Two renderers partition fills by role: `marketFillLevels` draws
`role == null`, and `tapeOrderLevels` draws tickets that carry a
`limitRate`. Every non-bracket peer was labelled `LIMIT`, so a **market**
execution — which has no `limitRate` — fell in the gap between them and got
no execution-level or timestamp tag at all.

**Lesson:** when two consumers partition on a label, a wrong label is not a
cosmetic problem, it is invisibility. Check that every value lands in
exactly one partition.

### The same question, different answers per consumer

A TP/SL bracket sitting at a strip edge is a real order with a real fill,
but it is **not** that leg's cover trade. Letting one stand in as the edge's
fill printed a spot take-profit's price under a forward leg's label
(an M6 row reading 1.16302 where the leg's own outright was 1.17078) and
sized the row off the bracket.

Removing the fallback outright broke the verify-strip-legs replay, which
legitimately reports a bracket-only edge's execution — and its test caught
it. `legPeersAtEdge` now takes `coverOnly`, opted into by the priced-legs
row and the free-leg check only.

**Lesson:** before changing a shared helper, ask whether its callers are
really asking the same question. Two of them wanted "did anything execute
here"; two wanted "did this leg trade". A parameter beat a redefinition,
and the existing test is what proved the difference was real.

### Shape attached to one privileged member

The ladder rides on `sourcePackage`, which was attached only to edge 0's
ticket. A strip whose first leg was never executed came back with no shape:
`stripPackageForTicketView` saw one edge, returned a one-leg package, and
the panel fell through to a synthetic default ladder whose edges did not
line up with the booked leg. It now rides on whichever leg books first when
no peer holds it.

**Lesson:** if a group's shared metadata lives on one designated member,
the group loses it whenever that member is absent. Attach it to whoever
arrives first, or store it beside the group rather than inside a member.

### The bug that was upstream of the symptom

"Chart is spot while the legs are forward" was reported as a charting bug.
It was not. Whole-strip execution booked every leg at the shared spot print,
so each leg's `fxOutright` equalled its `fxSpot`, the derived shift was ~0,
and the chart correctly drew what the stamps said. Fixed on the booking side
in `2ef4788` (each leg books at its own outright).

**Lesson:** when a derived view looks wrong, verify the inputs before
touching the derivation. One SQL query over the stamped points would have —
and eventually did — settle it in seconds.

---

## 4. Diagnostics that earned their keep

### The `[tape-load]` capture

`logTapeLoad` in the ticket panel reports **exactly which series the chart
resolved**, to the browser console and — via `POST /api/tape-load` — to the
dev server terminal, next to the `[fx-exec]` lines it correlates with.
Dev-only, deduped by load shape with a 5s floor.

Each line carries: ticket, role, instrument, `source`, key, shift, story
window, point count, first/last timestamps, mid range.

`source` names the path that won and, when the derivation was skipped, why:

| source | meaning |
|---|---|
| `leg-spot+points` | correct path — spot history shifted by the executed leg's stamps |
| `leg-spot+live-points` | same, but points came from the live quote (leg not booked yet) |
| `leg-own-key(no-points)` | no stamps and no live quote — nothing to derive from |
| `leg-own-key(no-spot-history)` | points fine, but the spot record has not arrived |
| `bracket-own-key` / `bracket-no-history` | bracket draft reading its own key |

A load that renders nothing shows as `points: 0` with the reason in
`source`. This is the first thing to look at for any "chart is wrong or
empty" report — it converts an argument about what the chart *should* show
into a fact about what it *did* load.

### The `[strip-open]` capture

Same sink, same terminal. On every strip open it prints the ladder the
panel resolved and **where it came from** (`booked-stamp` / `prepared` /
`default-seed`), every row with the peer it matched (`filled` / `working` /
`free`), and the raw peer list with each ticket's edge, status, role and
instrument.

It exists because "legs do not open as executed" has three very different
causes that look identical on screen: no peers supplied, no ladder
resolved, or an edge-index mismatch between rows and peers. The line tells
you which in one glance — `peers: []` is a supply problem,
`ladderFrom: default-seed` is a shape problem, and peers present with rows
resolving `free` is a mismatch. Several hours went into inferring between
those before this existed.

### SQL that settles arguments

Recording coverage — this is how the pre-execution gap was proven, and it is
the query to run whenever candles are missing rather than misplaced:

```sql
select to_char(to_timestamp("timestamp"/1000),'HH24:MI') as mm, count(*) as n
from leg_tape_ticks where "quoteKey"='EUR|spot'
  and "timestamp" > (extract(epoch from now())*1000 - 2400000)
group by 1 order by 1;
```

A minute with no row means nothing was recorded then, and **no client fix
can display it**. Full coverage is ~59–60 per minute.

Stamped points per booked leg — this is how "the chart is spot" was traced
to the booking path:

```sql
select t->>'maturityLabel',
       round(((t->'ipaQuote'->>'fxOutright')::numeric
            - (t->'ipaQuote'->>'fxSpot')::numeric)*10000, 2) as pts
from sandbox_progress_uat s,
     lateral jsonb_each(s.state->'hedgesByEntityId') e,
     lateral jsonb_array_elements(e.value->'bookedHedges') t
where s.task_id='02' and t->>'ccy'='EUR' and t->>'stripId' is not null;
```

Healthy values are real forward points (55.6 / 113.6 / 170.1 pips for
M4/M8/M12). Values near zero mean the legs booked at spot.

The live book lives in `sandbox_progress_uat`, in the entity bucket
`__group__` under `hedgesByEntityId` — not in a `bookedHedges` column, and
not in `matching_process_state` (which holds only process liveness; the
runtime's orders are in memory and come from the browser).

### Answering "which orders just executed, and why"

Two queries, in this order. First what filled:

```sql
select to_char(to_timestamp("executedAt"/1000),'HH24:MI:SS') t, "orderId",
       price, fill, ticket->>'bracketRole' role, ticket->>'limitRate' lim
from order_executions order by "executedAt" desc limit 10;
```

Then the tape at that second, which either justifies the fill or does not:

```sql
select to_char(to_timestamp("timestamp"/1000),'HH24:MI:SS') t,
       round(bid,6) bid, round(ask,6) ask
from leg_tape_ticks where "quoteKey"='EUR|spot'
  and "timestamp" between <fillMs>-15000 and <fillMs>+5000 order by "timestamp";
```

A sell take-profit fills on the **ask** (the 2026-09-08 convention), a stop
on the bid — so check the side the order actually fills against, not the
mid. A fill a fraction of a pip through its limit on the first crossing
print is correct behaviour, not slippage. Two orders sharing one price and
timestamp are one OCO group crossing on the same beat.

If the tape shows no print through the level at that second, that is the
`tape-never-crossed-level` verdict `POST /api/test/verify-strip-legs`
exists to report, and it is a real matcher bug rather than a display one.

---

## 5. Open issues

Ranked by how likely they are to bite.

1. **Cancelled orders can resurrect.** `5b5d6ff` (Sep 4) made hydration
   prefer the newer ticket list so a blotter delete wins, but
   `lib/test-mode/sandbox-client.ts` still falls back to a **union** merge
   whenever `hedgeBookLooksLikeAccidentalWipe` fires — which it does on the
   remount/Fast-Refresh signature. When that happens the older copy's
   tickets are merged back, resurrecting cancelled orders with their
   original ids. Confirmed live: four brackets cancelled at 00:11:24 (all
   four CANCELLED events in `execution_logs`) were still `scheduled` in the
   book an hour later. The real fix is a **tombstone** that survives the
   union merge; the current design can only narrow the window. The zombies
   from that session are still in the local sandbox.
2. **Legacy executions without tape.** ~126 rows in `order_executions`
   predate the ticket snapshot; their charts have no record to draw.
   Decision pending: leave the red guard, or render a two-point audit view
   (placement anchor plus execution print).
3. **Restart inside a post-fill tail loses the hold.** `bookedTapeHold` is
   in memory and `order_executions` has no owner columns, so a restart
   during the 180s tail stops that leg's tail recording.
4. **New brackets carry a negative `amountLocalM`** (`ht-mtt93a71-*`,
   −4.03M) where older ones are positive. Sign-convention difference
   between mint paths; unverified whether anything downstream cares.
5. **No paging of the served tape** — 600 points per key on every 2s poll,
   no `since` cursor.
6. **Four test suites fail at load** (`.claude`/`.cursor` hook and script
   tests, SyntaxError). Pre-existing, unrelated. Everything else is green:
   1,854 passing.

---

## 6. Operational rules

- **Bump `MATCHING_RUNTIME_REV`** on any matcher fill/tape behaviour change
  and **restart the dev server**. HMR otherwise keeps the old singleton
  filling on the old rules. Currently **40** (39 plus spot-tile strip orders
  booking as forwards).
- **OneDrive locks `.next`** — `EBUSY`/`ENOENT`, broken hot reload, and the
  server silently keeps executing stale matcher code. Exclude `.next` from
  sync; restart after runtime edits.
- **Never run two dev servers** against this checkout — they share `.next`
  and corrupt each other.
- **Local Postgres is portable, not a service.** After a reboot:
  `%LOCALAPPDATA%\pgsql-17\pgsql\bin\pg_ctl -D %LOCALAPPDATA%\pgsql-17\data -l %LOCALAPPDATA%\pgsql-17\postgres.log start`
- **A concurrent Cursor agent commits to `dev`** under the same git
  identity. Expect diffs you did not write (today: `2ef4788`,
  `execution-monitor.ts`, `click-trade-pad.ts`). Stage explicitly by path;
  never `git add -A`. Do not revert its work without asking — its
  deliberate choices (the yellow executed-level convention, for one) have
  been reverted by accident before and it was not received well.
- **It will commit your uncommitted work.** While a test run was in flight
  it committed the whole working tree, sweeping this session's changes into
  `ee8b8b2` under its own message. Nothing was lost, but verify your changes
  survived (`git show HEAD -- <path> | grep`) rather than assuming, and
  commit sooner so the boundary stays clean.
- **It also pushes whole PRs to `dev`.** PR #38 landed nine commits touching
  exactly the files this work touches. After any rebase onto its work, run
  `npx tsc --noEmit` **and** the full suite before pushing — a clean textual
  rebase says nothing about whether two independent fixes to the same
  behaviour still agree.

---

## 7. If you are picking this up cold

Start the dev server, open a strip ticket, and watch the terminal. You
should see `[fx-exec] leg tape DB persist ok: … keys=…,EUR|spot` appear
within a couple of seconds of opening the ticket — before you trade
anything. That single line proves watched-currency recording, persistence,
and attribution are all working.

Then execute one leg and reopen the booking. The `[tape-load]` line should
read `leg-spot+points` with a shift equal to that leg's forward points, a
window that starts at your click, and a non-zero point count. If any of
those three is wrong, section 3 almost certainly names the cause.
