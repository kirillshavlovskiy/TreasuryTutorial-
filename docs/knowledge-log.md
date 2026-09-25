# Knowledge log

One entry per commit. Newest first.

This file exists because the expensive part of a change is almost never in the diff. It is the
thing that was tried and thrown away, the number that was measured rather than assumed, and the
sentence in some other document that turned out to be false. All of that lives in a session
transcript and dies there.

## What belongs here

An entry is worth writing when the commit produced any of:

| Label | What it captures |
|---|---|
| **Measured** | A fact established by running something. Include the command and the result, not the conclusion alone. |
| **Rejected** | An approach that was tried or seriously considered and dropped — and why. This is the highest-value line, and the one no other artefact carries. |
| **Left open** | A gap accepted deliberately, so the next person knows it was a decision and not an oversight. |
| **Corrected** | A claim in the code, a doc or a comment that was found to be untrue. Name the file. |

Use only the labels that have content. Most commits will have one or two; some will have none.

## What does NOT belong here

- **A restatement of the diff or the commit message.** `git log` already carries what changed and
  why — the median commit body in this repository is 12 lines. An entry that paraphrases it is
  noise, and noise is how a log stops being read. When a commit produced no finding beyond its own
  message, write the heading and `No finding beyond the commit message.` — one line, not a
  paragraph.
- **An architecture decision.** Those go in `.claude/rules/project/decisions.md` through
  `fx-record-decision`, which asks for confirmation first. A decision is a rule for the future; a
  log entry is evidence from the past. If an entry starts prescribing what people must do next, it
  is an ADR wearing the wrong hat — move it.
- **Anything restricted.** No real balances, account identifiers, counterparty names, rates tied
  to a position, tokens or connection strings. `check-financial.md` section 6 applies to this file
  exactly as it applies to a log line.

## Format

```markdown
## YYYY-MM-DD `<short-sha>` <commit subject>

**Measured:** …
**Rejected:** …
**Left open:** …
**Corrected:** …
```

Worked example — this is an illustration of the shape, not a real entry:

```markdown
## 2026-01-01 `0000000` fix(example): stop trusting the scanner's boolean

**Measured:** `gh api repos/<org>/<repo>/branches/dev` reports `"protected": true`, but
`branches/dev/protection` is a 404 and `rules/branches/dev` returns only `["deletion", …]`.
**Corrected:** three places claimed the server would reject a direct push to `dev`. It would not —
the only rule is a deletion guard. Fixed in the hook header and the ADR.
**Left open:** nothing asks the platform team for a `pull_request` rule; that is the real fix and
it is not in this repository.
```

---

<!-- New entries go directly below this line, newest first. -->

## 2026-09-25 `5e45edf` fix(test-mode): the recorded tape around every fill is loaded for its chart

**Measured:** `leg_tape_ticks` held 12,272 `EUR|spot` rows for this user and task 02 from 12:07
to 17:41 UTC, with no gap at the 13:07:19 fill. So the history was never missing from Postgres;
the read truncated it.
**Corrected:** the route's comment "4000 newest rows ≈ 66 min of 1s prints, so a story that ran
for more than half an hour is not cut at its old end" holds only for stories under about an hour.
An open story (no `toMs`) of several hours loses its old end, which is exactly where its first
fills are.
**Rejected:** changing `loadLegTapeTicks` to read oldest-first. Its comment says verify-strip-legs
depends on newest-first, so that a retry's duplicate rows shrink the window from the old end. The
per-fill reads leave it alone.
**Measured:** one full `npm test` run at commit time showed a 4th failure that the next run did
not reproduce; it is the same intermittent test as before.

## 2026-09-25 `55f99e7` feat(test-mode): the tape draws BID or ASK candles, defaulting to the triggering side

**Rejected:** re-introducing bid-low / ask-high candles. `aggregateTapeCandles`' own comment
records why they were removed: every bar gained a half-spread wick at prices nothing traded at.
One side's path per bar keeps each OHLC a price that actually printed, and still puts the
triggering side's crossing inside its candle.
**Left open:** the default for a working OCO is its take-profit's side. Its stop triggers on the
other side, so the stop's crossing needs the toggle. No browser check.

## 2026-09-25 `e544304` fix(test-mode): a fill's executed print is part of the candles at its own time

**Measured:** the first leg's TP (`ht-mugyg4mq-8r5ydt`) has `isSpotReferenced: true`,
`stripLegPoints: 14.19`, `fxSpot: 1.14103` and `fxOutright: 1.14245`, and filled at
1790341639652 (13:07:19 UTC). `leg_tape_ticks` `EUR|spot` for that second reads bid 1.14083 /
ask 1.14103. So the matcher filled on a real ask print at the level. The chart's candles
(1.1410–1.1423) are the forward (spot + 14 pts) of ~13:20 UTC; its series starts about 13 minutes
after the fill.
**Rejected:** first hypothesis, spot candles under a forward level: `spotReferencedLegShift`
works for an executed ticket. Second, a narrow widening budget: `TAPE_FILL_WIDEN_MAX_PIPS = 5`
would cover a 1-pip ask-over-mid gap. Neither was the cause. `snapMsToTapeBar` snapping a fill to
the FIRST bar was.
**Left open:** why this chart's tape starts at ~16:20 local although Postgres holds the ticks
from 16:07. The in-memory history (journal `tapeByCcy` plus the matcher's heartbeat tape) did not
cover it, which is consistent with a matcher restart or a journal that failed to load. The Order
period never reads `leg_tape_ticks`, so a restart truncates every open order's story.

## 2026-09-25 `58e15b6` fix(test-mode): a journal served from the local fallback never enables saves

**Measured:** reviewing the pull, `git diff dev origin/dev` was empty for `TradeTicketPanel.tsx`,
`hedge-var.ts`, `rolling-hedge.ts`, `ticket-desk-label.ts`, `matching-process-runtime.ts` and
`tape-candles.ts`. So the merges that brought back `7666706`…`b093e3e` into history resolved every
chart and matching file to this checkout's version. The pull itself was a fast-forward, done by
another agent or sync at 17:48 during the review (`git reflog`: `pull --tags origin dev`).
**Corrected:** the incoming comment "Leaving it in place lets a later load retry the import" is
right, but its return value broke the callers' contract. `HedgingDecisionLayer` and
`OrgBookedTradesPush` both read "non-null journal" as "load succeeded".
**Left open:** the rest of the pull (hydration merge by clock, prepared packages no longer
unioned from the older store, optimistic-overlay membership check) was read and judged
consistent with the recorded persistence decisions, but was not exercised against a real race.

## 2026-09-25 `a0d288e` fix(test-mode): an order replaced by a fill-now is retired quietly

**Measured:** the blotter already hides rows with `dismissedAtMs` (`blotterTickets` in
`HedgingDecisionLayer`). The bell derives CANCELLED only from `cancelledNotices`, never from a
ticket's status. So dismissing without raising a notice is enough to hide a replaced order in both
places, while the ticket stays for the chart.

## 2026-09-25 `a84aa5c` fix(test-mode): the ticket panel no longer crashes on open (deskLiveRef TDZ)

**Measured:** `tsc --noEmit` passed on `9838bdb` and the crash only appeared in the browser.
`TradeTicketPanel` runs `clipToStory` → `seedDraftHistory` during the FIRST render, from the
`stickyPlaced` `useState` initialiser. Any `const` or ref those closures read has to be declared
above the initialiser, and the type checker cannot see a temporal-dead-zone read through a closure.
**Corrected:** my own `9838bdb` knowledge-log entry said it was only "not reproduced". In fact the
panel did not open at all, and nothing in this repository renders the panel, so the typecheck and
suite could not catch it.

## 2026-09-25 `9838bdb` fix(test-mode): the chart stays live while a strip leg is left to trade

**Rejected:** keying "the desk is still trading" on `limitMode` or `workingHit`. Both start set
(`restOpen` / `initialWorkingHit`) on a panel opened read-only on a cancelled order. A bullet fill
also leaves `workingHit` set. Either would keep a finished order's chart appending live ticks past
its story, which is the "cliff to today's rate" the story end exists to prevent. A strip leg still
free to trade is the one signal that is true only while trading continues.
**Left open:** the cause, cancelling beside filled legs so every ticket is done, was inferred from
`storyWindow.toMs` (`allDone && fillTimes`). It was not reproduced, and there is no browser check.

## 2026-09-24 `b093e3e` fix(test-mode): a leg pad wears the main tile's wash, keyed on the trade side

**Measured:** `git log -S roleWash -- components/test-mode/TradeTicketPanel.tsx` returns exactly
one commit, `45cfa45`, and its diff carries the rule in a comment: "Once the order is confirmed
the tile takes its real side's colour (sell rose, buy emerald) — **not the raw bid/ask hit, since
which one buys vs sells flips for currencies quoted USD-per-FCY**. Both can be lit at once for an
OCO." One `-S` search answered both halves of the report; three rounds of reading the rendered
colours had not.
**Corrected:** the leg pads I added broke that rule twice. A committed leg went slate grey, which
is the main tile's wash for the OTHER side of a fill, not its fill wash — and there was no
confirmed state at all, so a working order on a leg looked like an idle one. The tone was keyed on
`'bid' | 'ask'`, the precise thing the comment warns against.
**Rejected:** picking a colour scheme from the screenshots. Three readings of the rendered pixels
produced three different theories about which state was which, because several states share a
palette. The history stated the rule outright.
**Left open:** a leg has no equivalent of the main tile's `tileFilled` (the muted wash on the
non-executed side of a filled pair), so both leg pads keep their own colour after one side fills.

## 2026-09-24 `9ff3ac1` fix(test-mode): the main tile's BID/ASK chips follow the same one-highlight rule

**Corrected:** `56bc8f5` split the highlight on the leg pads and stopped there, which did not fix
the reported problem — it made it visible on both halves at once. Splitting one of two surfaces
that share a rule leaves them contradicting each other; the desk's screenshot showed a leg's BID
lit beside the tile's ASK.
**Measured:** the trap in doing it naively — `ClickTradeTile` receives `limitMode` as
`stripPadLive ? limitMode : Boolean(limitMode || selectedLegLimitOrder)`. That prop is true
whenever the SELECTED LEG merely carries an existing limit order, so deriving the chip state from
it inside the component would relight the chips during a market arm. `orderArmed` is computed at
the call site from the raw state and passed in.
**Rejected:** a JSX `{/* … */}` comment between attributes to explain that. It is not valid in
attribute position — `tsc` gives `TS1005: '...' expected`, which reads like a spread-operator
problem and not like a misplaced comment. It went inside the attribute expression instead.
**Left open:** three surfaces now encode "market lights the pad, an order lights the chip" — the
leg pads, the whole-strip row and the tile chips — and nothing ties them together. A fourth
consumer will have to be remembered, exactly as this one was not.

## 2026-09-24 `56bc8f5` feat(test-mode): one highlight per leg — pad for market, BID/ASK for an order

**Measured:** the two arms were already distinguishable in state and nothing read them apart —
`selectHitOnly` is called with `setLimitMode(false)` from the pad's `onHit` and with `limitMode`
true from the order control, so `limitMode` alone splits `rowArmed` into the two meanings. No new
state was needed; the display had simply been collapsing them.
**Rejected:** a third `armedKind` prop on the row. It would have duplicated what `limitMode`
already decides and given two sources that can disagree.
**Left open:** when the main pad arms the whole strip, `rowArmed` returns that side for EVERY row
(`mainStripReady`), so a strip-wide order now lights the control on every leg. That is arguably
right — the order does cover them all — but it is inherited behaviour, not a decision made here.

## 2026-09-24 `f75ffc9` fix(test-mode): the leg order control is labelled BID / ASK

**Corrected:** the request was "bid ask buttons" from the first message and stayed that way
through three restatements; the control shipped labelled "Order" anyway. The wording named the
labels, and each follow-up narrowed placement — style, then function, then corner — so the label
read as settled and was never re-read. Re-check the parts of a request that were not the subject
of the last correction; they are the ones that quietly go unimplemented.
**Left open:** no browser check, and the panel still has no component test, so nothing here would
have caught a wrong label either.

## 2026-09-24 `732da38` feat(test-mode): the order control sits inside the leg pad, bottom outer corner

**Corrected:** `3ebc680`, one commit earlier, put this control in a strip BELOW the card because
that is where the main tile keeps its equivalent. Mirroring the main tile's layout was not what
was being asked for — the control was wanted on the pad itself. Copying a reference design's
structure is not the same as answering the request it was offered for.
**Measured:** the pad had to stop being a `<button>`. A `<button>` inside a `<button>` is invalid
HTML and browsers reshape it silently — no error, no warning, just a DOM that is not what was
written. `HitPad` is a `div role="button"` for this exact reason, so the keyboard handling it
carries (Enter / Space, `tabIndex`, `aria-disabled`) had to be carried over with it rather than
inherited from the element.
**Left open:** the level is still typed on the main pad's order sheet; only the control that opens
it moved into the leg pad. Putting the sheet itself in the row was considered earlier and
rejected — `orderRates` is a single `Record<HitSide, string>` read by both `placeLeaveOrder` and
`submitLimitOrder`, so a per-row sheet forks the typed level. If that is what is wanted, it is a
state change, not a layout one.

## 2026-09-23 `3ebc680` feat(test-mode): a leg card can leave an order, not only market-execute

**Corrected:** the previous commit's framing. `7666706` restyled the leg quote into pads and its
message said behaviour was deliberately untouched — but the gap the desk was reporting WAS
behaviour: there is no control on a leg card that places an order, only one that fills at the
market. Restyling the market half made the missing half less visible, not more.
**Measured:** what the main tile actually is, read rather than assumed — a big `HitPad` that arms
and fills, plus a separate `LeaveRateButton` strip underneath whose click does nothing but arm the
pad in limit mode. `LeaveRateButton` takes `orderRate` / `onOrderRate` / `inputsLocked` and uses
none of them (three unused-var warnings on it predate this change); the level is typed on the main
pad. So mirroring it onto a leg row is a side hand-back, not a second order sheet.
**Rejected:** giving each row its own level input. It reads like the obvious way to "place an
order from the card", and it would fork the typed level into one copy per row — `orderRates` is a
single `Record<HitSide, string>` that `placeLeaveOrder` and `submitLimitOrder` both read.
**Left open:** the level is still typed on the main pad, so placing from a leg card moves the
desk's eye up the panel. That is what the main tile does too, and changing it is a layout decision
rather than a fix.
**Left open:** none of this is browser-verified, and there is still no component test for the
panel — the fourth entry in a row to end this way.

## 2026-09-23 `7666706` feat(test-mode): each leg card gets its own Bid / Ask pads

**Rejected:** reusing `HitPad`, which is what "same style as the main tiles" asks for on its face.
It is ~450 lines whose subject is the ORDER SHEET — `showOrderSheet`, `showOrderParams`,
`liveFillChrome`, level input, LIVE REF toggle, bracket role colouring, submit and cancel — and a
leg row renders none of it, because its click market-executes the row. Adopting it would have
meant a dozen props existing only to switch that machinery off, and a standing obligation to check
every future order-sheet change against a caller that never shows one. Only the visual language
was shared, and it is small: the wash triple (black / `#FF5722` / `slate-700`) and `splitFxPips`.
**Left open:** the two now carry that visual language independently, so a change to the main pads'
colours will not reach the leg pads. That is the price of not sharing the component and it is the
cheaper side of the trade, but it is a real duplication and nothing enforces it.
**Left open:** an option leg's premium is shown as a plain headline rather than through the pip
split — a USD premium has no big-figure/pips structure. Its rate sits underneath in the old small
type, so option rows are less changed than rate rows.

## 2026-09-25 `2364d4d` fix(test-mode): a level being composed looks exactly like the placed order

**Left open:** `TapeOrderLevel.preview` (from `cefa4c1`) is still set by `tapeOrderLevels`, but the
panel no longer styles on it. It was kept because `cefa4c1`'s tests assert it and it costs nothing;
removing it is that session's call.

## 2026-09-25 `e56c218` fix(test-mode): live TP / SL lines follow the order being composed again

**Corrected:** my own `e7cb1f1` introduced this. Giving a free leg a neutral `chartTicket` (id
`…:free-leg`) made `chartIsOwnLeg` false for any leg other than the opened order's. The preview
gate read `chartIsOwnLeg`, so a fix for one convention bug silently removed a feature that depended
on the old identity.
**Measured:** one full `npm test` run showed 4 failures and the next showed the baseline 3. The
extra one did not reproduce in two further runs, matching the known flaky Gemini live-smoke test.

## 2026-09-25 `5e3dab0` feat(test-mode): a level being composed reads as PENDING on the chart

No finding beyond the commit message.

## 2026-09-25 `c7d5a86` fix(test-mode): the day record read retries instead of giving up

**Rejected:** four other explanations for "it only loads on the second attempt", each ruled out by
reading the code rather than assumed away. `getSpotDayCandleRowModel` resets its cached promise to
`null` and rethrows on a failed init, so a model built while Postgres was down does not stick.
`backfillSpotDayLane` sets `backfilledFromMs` only after a successful read, so a failed backfill
does not mark the lane done. The tick-tape fetch in `HedgingDecisionLayer` releases its keys on
failure and re-runs on every book sync, so it self-heals. The candles route rejects a window
`> SPOT_DAY_MAX_WINDOW_MS`, and the client asks for exactly that, so the boundary passes.
**Measured:** with Postgres restarted, a cold module import calling
`spotDayCandlesFor('EURUSD', now-48h, now, 60)` returned 685 candles on the FIRST call, and
`barSec` 15 returned 2720 — the server has no cold-start miss to retry around, so the give-up was
purely client-side.
**Left open:** a fetch that hangs rather than rejects is still not covered — the retry only fires
on rejection. No timeout was added on purpose: a Next dev route compiling on first hit can take
many seconds and legitimately succeed, and a timeout would turn that into a retry storm. No
browser check.

## 2026-09-25 `f6cb785` fix(test-mode): composing an order on a free leg is never an order view

**Corrected:** `9153fe6`'s `viewingOrder` used `readOnly && ticket.limitRate` for strips as well.
`leaveRestingOrder` sets the panel read-only on the order it just left, so every composition after
the first one on a strip ran as a "view" and rendered the new order empty.
**Measured:** at commit time the other session had its candle-read retry STAGED in
`TradeTicketPanel.tsx`, not just unstaged. A plain `git commit` of a hunk-staged index would have
swept it in. The commit was built from a temporary `GIT_INDEX_FILE` holding `HEAD` plus this hunk,
and the same hunk was then applied to the real index. That index still diffed to the other
session's work alone.

## 2026-09-25 `9153fe6` fix(test-mode): a working order's chart line and sheet stay on its own level

**Rejected:** the first hypothesis, that the fill-mark fallback in `tapeFills` drew L2's bulk
report fill under L1's TP role. Reading it, the strip branch returns `[]` for an unfilled bracket
focus before it reaches the report. The yellow "TP" was a FILLED level (`tapeOrderLevels` colours
filled levels `#facc15` with no suffix), which pointed to `stickyFills` keyed by ticket id.
**Measured:** 1.14710 on the chart is exactly L2's booked fill in the screenshot, and the pad's
1.14713 is an armed leg-forward rate. Neither is a level the L1 order was ever given.
**Left open:** a session already polluted keeps its frozen sticky price until the page is
reloaded. No browser check.

## 2026-09-25 `54d04fa` fix(test-mode): quick fill sits opposite the side the working order was placed on

**Measured:** the only working order in `sandbox_progress_uat` (task 02) was an EUR take-profit on
edge 2, with `orderHit: 'ask'`, `orderSide: 'Sell'` and no OCO. Under `593cbb1`'s rule its hint
landed on the ASK, the same pad the desk had placed it on. The desk wants the opposite.
**Corrected:** `593cbb1` read "TP side / SL side" as the bracket pads. The desk meant: fill on the
side opposite the one you placed from. That side is also where a market fill of the order
executes, which resolves the sell-at-the-ask pricing concern for this path.

## 2026-09-25 `938212f` fix(test-mode): a leg fills only on a second click on the side the first click armed

**Left open:** reading the code, I could not find the path by which a first click executed. At
open, `hitTarget` is `{ kind: 'main' }`, and a leg's `already` check needs that leg and side armed
with limit mode off. The token makes two clicks a hard rule instead of a property of shared state,
but the reported single-click fill was not reproduced, so the actual cause is unconfirmed.

## 2026-09-25 `593cbb1` fix(test-mode): "click to fill" sits on the working order's own side, in place of BID / ASK

**Left open:** the fill books the cover's direction at the clicked side's quote (`fillFromRow`).
So on a Sell TP, whose hint is now on the ASK in the desk's bracket convention, fill-now books a
sell at the ask, not the bid a market sell would get. This is the same pricing rule as every leg
click, raised with the desk and not changed.

## 2026-09-25 `ea562dc` fix(test-mode): a leg's working order can be filled at market now, replacing the order

**Corrected:** in `bb55c95` I put "click to fill" on the ARMED side of legs with no order. The desk
meant the opposite: a hint on a WORKING-order leg's fill side while it is not armed, gone once
armed. The request "add small label next to live bid/ask" was read against the wrong leg state.
**Left open:** a leg row's other side is still clickable. Leg fills take their direction from the
cover's sign and their price from the side clicked (`fillFromRow`), so hitting the ASK on a sell
leg books a sell at the ask. This predates the change and was left as it was. No browser check.

## 2026-09-25 `bb55c95` feat(test-mode): a leg's working order gets its own Edit and Cancel; armed sides say "click to fill"

**Rejected:** wiring the leg's Cancel to `requestCancellation`, the handler the modal and blotter
already use. For a strip ticket it cancels the strip's whole unfilled remainder and re-stages the
package from `preparedHedgeFromBookedTickets`, which is a strip-level action. The leg Cancel gets
its own `cancelWorkingOrder`, sharing `retireOneOrder` with the edit resubmit.
**Left open:** a leg Cancel does not recompute the card's hedge ratio or re-stage anything, on the
assumption that a working order is not booked cover. This was not checked against the Decision
card's numbers. No browser check.

## 2026-09-25 `14164c8` fix(test-mode): Edit on a strip leg opens an editable order, and resubmits only that order

**Measured:** `editWorkingOrder` was never the problem. It remounts the panel (`'edit'` key), sets
`viewOnly` false and drafts the order. The panel's leg preselect then picked the order's leg, and
`viewOnly = !stripPadLive && selectedLegLimitOrder` read that leg as an order view. Bullets were
unaffected (`selectedLegLimitOrder` is `restFilled` there, false for a working order), which is
why only strips broke.
**Corrected:** `hedgeTicketsRemovedBy` is documented as cancellation semantics ("drop an entire
strip"). Both edit resubmit paths in `HedgingDecisionLayer` reused it through
`removeHedgeTicketOrStrip`. So editing one leg's order cancelled every other working leg order of
the strip, silently, because no CANCELLED notice is raised on the edit path.
**Left open:** no browser check of an edit round-trip.

## 2026-09-25 `81c3992` fix(test-mode): bulk arm lights only the legs it fills, and the filled tile greys again

**Corrected:** `fff4d0c` treated "a leg left untraded" as one case. It is two. A leg dropped for a
missing live price is still free and needs another click, so the panel must not freeze. A leg
skipped because an order works on it is not tradeable at all, so the freeze (and its grey filled
tile) is correct. Merging them made every bulk fill beside a working order look unexecuted.
**Left open:** releasing the freeze when a skipped leg's order is cancelled is decided by
`freeStripLegKeys`, from booked peers. It has not been exercised against a real cancellation, and
there is no browser check.

## 2026-09-25 `4d40bbb` fix(test-mode): the unselected strip tile stays the market pad after a click

**Measured:** the desk's two screenshots pinned the trigger. Before any click, with L5 selected,
the tile was normal. It turned into an order sheet only when the main tile was clicked. That
click deselects the leg (`resetStripPadToSpot`), and on that path `stripPadLive` read `!restOpen`
and the view-only sheet read `readOnly && ticket.limitRate`. The sheet's 1.15762 is an L5 M12
forward bid: `selectHitOnly` pre-fills `orderRate` from the previous render's `tileBid`, which is
still the leg's forward.
**Corrected:** `c250573` justified "a working order keeps its own sheet on the unselected pad" as
the case `restOpen` was added for. On a strip that sheet showed the order next to rates that were
not its own, and the desk read it as the tile failing to reset.
**Left open:** the main-tile arm still pre-fills `orderRate` from the previous leg's forward. This
is harmless in market mode (never shown, not used unless edited), but it is a stale value.

## 2026-09-25 `cefa4c1` fix(test-mode): a level being composed still draws beside a cancelled one

**Rejected:** merging a preview for any role not claimed by a *live* level. Two existing tests in
`ticket-desk-label.test.ts` encode the opposite and are right: `previewRates` is the pad's
market-derived default until the desk edits it, not a typed intention, so a working SL would have
gained a phantom TP line at the pad's default ask. Narrowed to "a cancelled level does not block
the preview" — which is the reported case and nothing wider.
**Measured:** a concurrent session in this same worktree reverted in-flight edits to
`ticket-desk-label.ts` and `TradeTicketPanel.tsx` three times between consecutive tool calls.
After a verified-green run, `grep -c` returned 0 for the PENDING title, 0 for the pending colours
and 0 for the day-record retry, while the `today` lookback default (same file) survived; `tsc`
then failed on `preview` missing from `TapeOrderLevel` in a file where it had already been added.
`git status` showed `MM` on `TradeTicketPanel.tsx` — their staged hunks under my unstaged ones.
**Left open:** no browser check. The call-site gate `previewRates: limitMode && chartIsOwnLeg ?
orderRates : null` was never observed at runtime, so if a composed level still draws no line on
some strip-leg selection, that gate is the remaining suspect and not `tapeOrderLevels`.
`TradeTicketPanel.tsx` is uncommitted for the same reason — its working tree mixes two sessions'
work and splitting it was not attempted.

## 2026-09-25 `cf9a640` feat(test-mode): a selected leg places its own orders from BID / ASK on its row

**Measured:** another session was editing `TradeTicketPanel.tsx` and `ticket-desk-label.ts` at the
same time. `git add` of the whole file swept its `level.preview` hunk into the first attempt
(`98b5ba2`, soft-reset and never pushed). Reverse-applying its edits to test my change alone
removed two of its `tapeOrderLevels` hunks from disk while it kept writing, so the re-apply
failed. It rewrote them itself. The live file then matched the saved copy plus one reworded
comment.
**Rejected:** a throwaway `git worktree` to test the staged commit alone; the permission was
denied. Instead, no test imports `TradeTicketPanel` (`git grep` finds it only in comments), and
`tsc` passed while the tree matched the staged commit exactly.
**Left open:** no browser check.

## 2026-09-25 `e7cb1f1` fix(test-mode): one spot/forward convention per chart, pin and row

**Measured:** a read-only audit of the panel found 13 places where spot and forward conventions
can mix. The reported chart was item 0. The "chartLegShift = 0 with no row selected" theory was
checked and rejected as its cause: with `liveFromSpot` false, neither live writer reads the shift.
The real cause was `liveTapeQuoteForOrder`'s `looksLikeSpot` (40-pip test in `tape-candles.ts`),
which fires for every EUR M1 and M2 forward.
**Rejected:** widening the seed filters (`liveForLeg`, `liveForBracket`) to always use the new
chart quote. A second review found that on the Order period `overlayOpenTapeTrail` then deletes
recorded history more than 40 pips from today's price, so the old conditions were kept.
**Rejected:** gating the opened order's level lines on `chartIsOwnLeg` for bullets too. A bullet
forward limit is stamped spot-referenced, so `chartIsOwnLeg` is false on its own chart and the
LIMIT line disappeared. The gate now applies to strips only.
**Left open:** orders placed before 2026-09-11 and legacy spot TP/SL fills (no
`isSpotReferenced`); a cancelled order in the bell showing its placement rates; no browser check
and no component test for the panel.

## 2026-09-25 `fff4d0c` fix(test-mode): strip bulk execution, order kind and tile highlight in the ticket panel

**Measured:** `sandbox_progress_uat` (task 02) showed strip `…mufujnpn…` with edges 0 and 2 each
booked twice: a take-profit fill, then a market fill 23–51 s later from one bulk click. On strip
`…mufyn378…`, every edge had a clean fill, while the open modal showed two of them as PENDING.
Both results fixed the defect class before any code was read.
**Rejected:** cancelling a leg's resting order when the bulk click fills that leg, inside
`mergeStripTicketsIntoBook`. Review found the slot key has no strip identity, so it could cancel
an order on a different ladder at the same tenor; the bulk click skips those legs instead.
**Corrected:** my comment claiming "bracket role and OCO link are set by each path" was false.
`placeLeaveOrder` sets neither, so both are now stripped from `orderSeed`.
**Left open:** `restingSides` is a `TradeTicketPanel` prop the parent never passes (always `[]`).

## 2026-09-25 `6cda742` fix(test-mode): the blotter shows the rate an executed order booked

No finding beyond the commit message.

## 2026-09-25 `9d0572d` fix(test-mode): a strip that finishes while the modal is open stays on screen

**Rejected:** a looser first version, "resume if any ticket filled after the overlay opened". The
review showed it resumed an old strip that had finished before the modal opened, as soon as a
leftover leg filled beside it. The check now runs on the strip as it stood at open.
**Measured:** the "free legs inactive" report came from the working tree being restored to
`7964ed0`, which predates `c250573`. `c250573` was already on `dev`; re-applying it only brought the
tree back to `dev`'s version, so it is in none of these four commits. The restore had also staged
older `helm/`, `.github/`, `.claude/settings.json` and `docs/knowledge-log.md`. Each matched `7964ed0`
exactly (`git diff 7964ed0 -- …` was empty), so they were reset to `dev`'s versions and not committed.

## 2026-09-23 `c250573` fix(test-mode): a free leg quotes live even when the panel opened on an order

**Corrected:** the doc comment on `stripPadLive` said the switch "must NOT key off the ticket that
opened the panel" and named `restFilled` / `liveFilled` as the offenders that had been removed —
while `!restOpen`, in the very next expression, is the same thing. A second prose comment four
lines above it actively defended `restOpen`. The two comments contradicted each other and the
wrong one was the code.
**Measured:** this is the third distinct latch found in one sitting on the same panel, all with
the same shape — state belonging to the ticket that opened the panel, or to the last order placed,
outliving the thing it described (`submittedHit`, `limitMode`, now `restOpen`). None had a test;
the panel has no component tests at all.
**Rejected:** deleting the `restOpen` term outright. It is right for the case it was added for —
with no leg selected there is no other leg to show, so a working order keeps its own sheet.
Narrowing it to the unselected pad preserves that and fixes the selected-leg case.
**Rejected:** leaving the rule inline, as with `selectedLegTarget` an hour earlier. That one was a
three-line lookup whose bug was at the call site; this is a four-input boolean that has now been
got wrong twice in opposite directions, which is exactly what a named, tested predicate is for.
**Left open:** still no browser check. `npx vitest run --exclude "**/live-smoke.test.ts"` gives
2,590 passing and the 3 known `scripts/scratch` failures.

## 2026-09-23 `7964ed0` fix(test-mode): picking another leg releases the pad, so the next order needs no reopen

**Measured:** `grep -n "submittedHit"` over `TradeTicketPanel.tsx` — 18 references, one
`useState(null)` and one `setSubmittedHit(hit)` on submit. No other writer. `clearReady` (which
Escape and the pad's CANCEL both call) clears `workingHit` and `hitTarget` and deliberately not
this. So the latch had no release at all and a remount was the only exit, which is exactly the
close-and-reopen the desk was doing by hand.
**Corrected:** two behaviours that had been read as separate reports — "I must reopen the modal to
place the next leg" and "clicking a pending leg does not chart its forward" — are one latch. Both
`submittedHit` and `limitMode` are set when an order is left and neither is released;
`limitMode` is half of `chartLimitWorking`, so it pinned every subsequently selected leg to the
spot chart whether or not that leg had an order.
**Rejected:** clearing the latch inside `selectHitOnly`, which also calls `selectStripLeg` for a
leg target. That path runs while ARMING, so it would have dropped the double-submit guard for the
order being placed. The release is on the explicit `onSelect` of a row instead — a desk action
that means "different leg", not a side effect of arming.
**Left open:** a leg that genuinely has a working order still charts on spot, deliberately
(decisions.md 2026-09-07 / 09-11) — its level rests on the spot tape and drawing it on the leg's
outright would put its own lines ~114 pips off the candles. If the desk wants the forward visible
there too, that is a second series on one chart, not a convention switch, and it is not built.
**Left open:** the suite baseline is 3 failures, not 4, when `live-smoke.test.ts` is excluded
(`npx vitest run --exclude "**/live-smoke.test.ts"` → 2,585 passing). That is the faster way to
read the real signal while the Gemini call keeps timing out.

## 2026-09-23 `36bc56e` fix(test-mode): a recording gap is a hole in one tape, not a new convention

**Measured** (by the authoring Cursor session, quoted from its code comments, not re-derived here):
one EUR session kept 3,958 of 17,862 genuine spot prints — a chart holding since 10:31 opened at
15:16 — and contamination was observed beginning immediately after a 14-minute outage, which is
why a boundary is still drawn at every jump rather than only at adjacent ones.
**Rejected:** keying the decision on the gap alone. A jump after a long silence is usually the
market moving, but not always — so the rule is "does the main line come back": a stretch the
series returns from is an excursion and is dropped, one it never returns from is a real switch and
still cuts. Gap length only breaks the tie when nothing returns.
**Left open:** `TAPE_CONVENTION_BREAK_MAX_GAP_MS` is 10s, chosen as "a beat or two", not
calibrated against the recorder's actual stall distribution. A convention switch that happens to
land across a longer silence will now be kept rather than cut.

## 2026-09-23 `372f423` fix(test-mode): a spot ticket seeds the shared spot key from its stamped spot

**Corrected:** the booked-leg seed in `matching-process-runtime.ts` was doing the exact thing
`decisions.md` (2026-09-07) forbids — "do not seed the shared spot key from `restingAnchorRate` in
preference to the stamped spot" — and had been since that entry was written. The ADR named the
failure mode precisely, including why it is silent: a short-tenor outright sits *inside* the
40-pip continuity band, so nothing rejects it; the tape is simply seeded pips high. Two other seed
sites already used `spotTapeSeedMid`; only this one diverged. Writing the rule down did not make
the third call site obey it.
**Left open:** nothing tests that the three seed sites agree, so the next one added can diverge the
same way.

## 2026-09-23 `dec1c3d` fix(test-mode): a chart opens on the day, not the last sixty minutes

**Corrected:** several sessions of this repo's recent work — including mine — treated "no chart
before 3pm" as evidence that recording had failed. Part of it was a default: the book-session From
window was `1h`, so a chart that held since the morning opened on the last sixty minutes of it.
The persistence defects found alongside were real, but the symptom that kept prompting the hunt
was partly this.

## 2026-09-23 `c67741c` chore(claude): allow the shell commands these sessions actually ran

No finding beyond the commit message.

## 2026-09-23 `fee02aa` feat(test-mode): a limit order covers the picked leg, the strip only when none is

**Measured:** the suite baseline moved and it is not this change. `npx vitest run` gives 4 failures
in 3 files: the 3 known gitignored `scripts/scratch` ones plus `lib/agent/live-smoke.test.ts`,
which makes a real Gemini call and timed out at 90s. Stashing every local change and running that
file alone reproduces it — 90.63s, same failure — so it is network, not code. Anyone reading "3
scratch failures" as the baseline from an earlier entry will now see 4 and should check this first.
**Measured:** the targeting machinery was already per-leg on every path that matters —
`stripRowsForOrder` returns `[row]` for a leg target, `makeTicket` sizes off `row.sizeM`,
`readyAllLegs` already requires `selectedLegKey == null`. Nothing reached them, because one line in
the pad's `onLeave` nulled the selection first. The feature was one assignment away the whole time.
**Rejected:** changing `onArm` / `onFill` on the main pad the same way. They are the market path,
and the 2026-09-08 desk rule is that the main pad is spot/whole-strip for market while the row
tiles market-fill a leg. Only the limit path was wrong, so only it moved.
**Rejected:** extracting the selection rule into `click-trade-pad.ts` to unit-test it. It is a
three-line lookup, and a test of it would not have caught this defect — the defect was the caller
discarding the input. `engineering.md` forbids a helper module for a one-off, and a test that
cannot fail on the real bug is worse than none because it reads as coverage.
**Corrected:** `selectHitOnly` seeded a limit level from the leg's forward outright when the target
was a leg, while three other places — the `bracketRefBid` comment, `placeLeaveOrder` and
`restingLevelForLeg` — all say a working limit rests at a spot level "whatever leg it is for". On
the book in the report that is 1.15030 against a 1.13894 spot tape, 114 pips. The contradiction was
invisible while no leg order could be placed; enabling the feature would have shipped it.
**Left open:** no browser check, and this panel still has no component test — so "an order now
lands on one leg" is traced through `onLeave` → `padHitTarget` → `stripRowsForOrder`, not observed.
The way to settle it is one leg order and a row count in `order_executions`.

## 2026-09-23 `7f25026` fix(test-mode): editing a working order can open its level field

**Measured:** the freeze is unconditional on entering edit mode, by construction rather than by
luck: `restOpen` is true for any `scheduled`/`cancelled` ticket with a level, `initialWorkingHit`
is then non-null, and `freezeInputs = readOnlyActions || workingHit != null || …`. So every edit
starts frozen. `npx vitest run` — 2,586 passing, 3 failing, all three the known gitignored
`scripts/scratch` files. `next lint` warning set is byte-identical to `HEAD`'s (checked by
stashing), only line numbers move.
**Corrected:** `2876b02`'s own log entry claimed the reported symptom "may be a different defect
on the same button". It was — this one. That commit fixed Edit being *offered* on orders the
handler refuses; it did nothing for an order that is genuinely editable, which is what the desk
was clicking. Separately it left a `tsc` error in `hedge-var.test.ts`, found by a concurrent
session's run, not by mine — I typechecked before writing that test's final form and did not
re-run afterwards.
**Rejected:** deleting the `inputsLocked` branch in `openLeave` outright. It reads as dead weight
but it is the only guard on a pad that is frozen *outside* limit mode, and the button's `disabled`
already encoded the correct rule — so the fix is to make both read one function, not to drop one
side. The duplication was the defect.
**Left open:** not checked in a browser. The claim verified here is that the field may now open;
that a changed level then resubmits, cancels the original and reaches the matcher is traced in
code (`leaveRestingOrder` → `removeHedgeTicketOrStrip(editingOriginal)`) but not run. The edit path
also still writes no audit trace — `decisions.md` "Notification bell event coverage" already
records that and it is untouched here.

## 2026-09-23 `c855575` fix(test-mode): a limit order's level starts at live spot, not the forward

**Measured:** `npm test` gives 3 failures, all in the known `scripts/scratch` files, and 2,582 passes.
`tsc --noEmit` reports one error outside `scripts/scratch`, `hedge-var.test.ts:2821`
(`filledAtMs` on a `Pick<HedgeTicket, "status" | "limitRate">`). That error arrived with 2876b02
and this change did not cause it.
**Left open:** the pre-fill sits **at** live spot on the hit side, the same as the SL autofill. So
`classifyBracketLevel` reads it as `triggered`, not `rests`, until the desk moves it off the market.
No off-market offset was added. Leg-row clicks never enter limit mode, so they were not changed. No
browser check was made.

## 2026-09-23 `2876b02` fix(test-mode): Edit is offered only on an order that can be edited

**Measured:** the desk's 26 EUR tickets in `order_executions` are 5 booked and 21 cancelled —
**zero** `scheduled`. Fills land ~45s after placement, so for almost all of that history the Edit
action was on screen attached to an order `editWorkingOrder` refuses. Editing itself does work: the
13:32:42 → 13:33:54 sequence shows three take-profits at 1.15567 replaced by a TP at 1.1417 and an
SL at 1.14, with the originals cancelled in the same minute.
**Rejected:** hiding the action by checking `status` at the call site. The guard has to run on the
ticket that would be **resubmitted** — for an OCO pair that is `ocoDraftPrimary`'s primary, not the
leg that was clicked — so the predicate moved into `hedge-var.ts` and both sides ask it. Doing it
at the call site would have kept a real hole: a still-scheduled leg whose primary had already
filled opened the booked order for editing.
**Left open:** this is the silent no-op only. Whether an editable order opens with usable inputs
and resubmits correctly is unverified — `tsc`, `next lint` and 2,582 passing tests (bar the three
known gitignored `scripts/scratch` failures) do not touch the placement path, and no browser check
was made. The reported symptom may therefore be a different defect on the same button.

## 2026-09-23 `53587b6` fix(test-mode): a working order's spot chart is never fed the draft's forward

**Measured:** from the desk's screenshot alone — one bar at 1.14514 (L2's M3 outright, the row
quoting 1.14499/1.14501) against TP/SL lines at spot 1.14150/1.14000 on a 48h window with no other
candles — before reading any code. The number pinned it to a forward series in a spot chart; the
empty 48h pinned it to the continuity filter, which only drops ticks outside the Order period.
**Corrected:** the previous turn's answer, that every branch "should" give a spot chart and the
fault was probably a stale tab. It was wrong: the draft-key merge effect is a trail writer outside
the seed, and reading the seed alone never reaches it. There are nine `setTapeTrail` writers; any
convention rule has to hold for all of them, not just the reset.
**Left open:** the other writers (fill marker, heartbeat ingest, 1s push) were read, not tested —
this panel still has no chart test. Not confirmed in the browser.

## 2026-09-23 `eac8e1e` fix(test-mode): the spot-seed guard tests the selected leg's own order

No finding beyond the commit message.

## 2026-09-23 `a5e8c8c` fix(test-mode): a working limit order's chart is spot all the way through

**Measured:** an independent review agent (Opus, read-only) over `git diff 51bafc4 HEAD` found 3 HIGH
and 4 MEDIUM defects that `tsc` and 2571 passing tests did not catch — none of those tests drive the
panel's chart or order-creation closures. The chart one was confirmed in code before fixing:
`bracketShift = spotReferencedLegShift(chartTicket) ?? 0` never read `chartIsSpot`.
**Corrected:** `c3ec49e` said a working order "draws on the spot chart". Only its level lines did;
the candle seed, the placement pin and the live-tick source stayed forward.
**Left open:** a concurrent session committed half of this work mid-edit (`1ff694a`, swept from the
working tree) and changed one guard to read the opened ticket, which `eac8e1e` corrects. An option
leg with no live print still rests unshifted. A market click can still show an older fill at the same
edge (review MEDIUM #5, edge case, not changed). Still no browser check.

## 2026-09-23 `1f0d405` fix(test-mode): an executed limit order's card and chart read in one convention

**Measured:** the real strip `strip-EUR-ht-mue1j9o1-v1072j` booked correctly on every leg (spot limit
1.14150, fills at spot 1.1416091284871182, L1 booked 1.1444501284871182 = print + 28.41 pts, Decimal
hand-check exact) — the defects were display only. The dashed 1.14593 line in the report was the
crosshair, not an order.

## 2026-09-23 `c3ec49e` fix(test-mode): a working limit order is spot everywhere, an executed one is FWD

**Rejected:** `b51be57`'s model — a forward-leg limit referencing its leg's outright, with the typed
level converted leg by leg. It was self-consistent but not the desk's rule: working orders are
spot, executed ones FWD. Reverted within the hour; its per-leg `ipaQuote` stamp and shared
`padHitTarget()` were kept because they are right under either model.
**Measured:** the matcher needed no change. The existing runtime test "fills a forward leg left on
the spot tile off the spot tape and books spot + its points" already proves the working→executed
path: no forward key while resting, fill off `EUR|spot`, booked `fxOutright` = print + 170.1 pts.
**Left open:** one typed spot level now serves every leg of a strip (they trigger together, each
booking its own forward) — confirm that is what the desk wants for a ladder. Orders already on the
book keep their old shape. Not checked by placing an order in the browser.

## 2026-09-23 `b51be57` fix(test-mode): a limit order is typed, stamped and drawn in its leg's convention

**Measured:** in the real `MatchingProcessRuntime` (new test), a Sell TP on a 6.86m EUR leg 31 pips
above its outright, stamped `fxOutright = limit` as `ca33086` stamped plain leaves, FILLED on the
first beat; stamped with the leg's own outright it stays working. So `ca33086` made every plain
limit on a strip fire at placement, not merely draw wrong.
**Measured:** at `51bafc4` (asked about as a "known good" point) all three defects were already
present: `stripOnSpot || bracketRole ? typed` (from `4883edf`, 09-22), the unscoped
`target.kind === 'leg'`, and spot `bracketRefBid` on forward brackets (from `eb07749`, 09-08).
Before `4883edf` the bracket line read `stripOnSpot ? typed : limitRate` — what `a9473f7` restored.
**Corrected:** the `bracketRefBid` comment said every TP/SL is spot-referenced per decisions.md
2026-09-07. That decision covers spot-instrument tickets and the spot-tile (`isSpotReferenced`)
path; a forward-tile bracket is keyed by `tapeQuoteKey` to its outright tape and always was.
**Left open:** decisions.md has no entry saying forward-leg brackets reference the outright — the
2026-09-07 entry can still be misread the way `eb07749` read it. Orders already on the book keep
their old stamps. Not checked by placing an order in the browser.

## 2026-09-23 `66e0144` Merge remote-tracking branch 'origin/dev' into dev

No finding beyond the commit message.

## 2026-09-23 `a9473f7` fix(test-mode): a strip bracket leave books each leg at its own converted rate

**Measured:** a strip booked after `ca33086` (`strip-EUR-ht-mudz05y5-3nd12x`) still carries
`limitRate 1.14516` on all seven legs while `maturityMonths` runs 1.71 → 12 and `instrument` is
`forward` with no `isSpotReferenced` — so it went through the forward-tenor leave path, not the spot
tile, and the conversion `ca33086` fixed was being computed and dropped.
**Corrected:** `7ee97e7` proved `stripRowLimitRate`'s arithmetic and the log entry for it said
"nothing end-to-end is" proven. That was the right warning: the result never reached the ticket,
because `makeTicket` overwrote it with `typed` whenever `bracketRole` was set — which is every call.
**Rejected:** treating the flat rate as the documented spot-tile behaviour (decisions.md
2026-09-11). That rule covers orders left on the SPOT tile only; these legs are `instrument:
forward` with `isSpotReferenced` null, so it does not apply.
**Left open:** not verified by placing an order in the browser, and there is still no test that
drives `makeTicket` — both defects live in closures inside the panel. The `referenceStopLoss`
effect (defaults on for a non-OCO order, rewrites the sibling pad's rate from the live spot
reference) was checked and targets only the opposite pad, so it is not this bug.

## 2026-09-23 `3b2b379` test(test-mode): prove the per-leg limit conversion instead of asserting it

**Measured:** the three limit legs on the book still read `limit 1.14410`, `25.3p` for M3.43,
M6.86 and M10.29, all stamped `09-23 11:01:00` — the same tickets booked BEFORE `ca33086`, not
new ones. A fix to the placement path cannot rewrite a stored `ipaQuote`, so that screen could
never have shown whether the fix works.
**Corrected:** `ca33086` was reported as fixed on the strength of tsc, lint and a green suite.
None of those exercise placement — no test placed a multi-leg limit order or asserted per-leg
levels — so the claim rested on reading the code. That is the same unverified-claim mistake made
on the tile fix earlier the same day, repeated after being called out for it.
**Left open:** the arithmetic is now proven in isolation, but nothing end-to-end is. Whether a
newly placed ladder stamps per-leg points still needs one real order placed through the UI and its
stored stamps read back. The three legs already on the book stay mis-booked; they need re-booking.


## 2026-09-23 `d27a92a` fix(test-mode): each leg of a left strip order books its own forward

**Measured:** three take-profits on the book — M3.43, M6.86, M10.29 — all carry `limitRate
1.14410` and identical stamps (`fxSpot 1.14164`, `fxOutright 1.14417`, 25.3 pips). The market
fills beside them scale correctly with tenor: 25.0p at M1.71, 74.4p at M5.14, 121.6p at M8.57,
170.1p at M12. So the leave path, not the click path, was losing the per-leg conversion.
**Corrected:** a regression I introduced in `d10646a` (13 Sep). That commit nulls
`stripQuotes[].bid/ask` unless both sides price off a live print, and its own message records that
it made a strip market fill refuse any leg without a rate — one consumer. `limitForStripRow` reads
the same `quotePxForRow` and falls back SILENTLY to the typed rate, so the whole ladder collapsed
onto one level. CLAUDE.md's "grep for every caller before changing shared behaviour" is the rule
that was missed.
**Rejected:** refusing the placement outright when legs are unpriceable — the panel has no notice
mechanism (`setPadHint` does not exist), so Submit would have silently done nothing, trading a
visible wrong booking for an invisible non-booking. Also rejected: reusing the live outrights,
which is what the live-print rule forbids. The curve POINTS difference is used instead, because a
leg-to-leg spread does not depend on the spot anchor and so cannot carry a seed level into a
booked rate.
**Left open:** `...draftTicket` handing every leg the draft's ipaQuote PREDATES `d10646a`
(verified at `d10646a^`); it was masked while per-leg limits still differed. Per-leg stamping now
covers the leave path, but any other path that spreads one draft across several legs has the same
shape. The three legs already on the book stay mis-booked and need re-booking.

## 2026-09-23 `b5bc10b` chore(deps): clear the Aikido SCA findings

**Measured:** every fix version's publish date against `.npmrc`'s `min-release-age=7`. On 21 Sep
five of them were inside the floor and npm would have refused them — `proxy-addr@2.0.8` (6.1d),
`brace-expansion@1.1.21` (6.4d), `ip-address@10.7.1` (6.1d), `moment@2.31.0` (6.3d),
`fast-uri@3.1.8` (6.0d), all one coordinated advisory batch published 14–15 Sep. Re-measured on
23 Sep they are 8.1–8.5d and all pass. `npm ls undici` afterwards shows 7.29.1 and 8.10.2, one
copy each.
**Rejected:** two pieces of the scanner's own advice. It recommended `fast-uri >= 2.4.7`, which is
a DOWNGRADE from the pinned 3.1.6 — the real fix in that line is 3.1.8. And it recommended taking
the transitive `undici@7.29.0` to 8.10.2, but `@ai-sdk/provider-utils` declares `^7.28.0` and
7.29.1 was published the same day as 8.10.2; following the scan would have forced a major bump
outside a declared range for no reason.
**Left open:** `npm audit` still reports one high — prototype pollution and ReDoS in `xlsx`, "No
fix available", not in the Aikido list. It is the documented case in CLAUDE.md of a finding with
no upgrade path, and no decision has been recorded for it.

## 2026-09-23 `d8d7d54` fix(test-mode): a forward-tile order's placed pin sits on its own series

**Measured:** the three resting EUR take-profits on the book all store
`restingAnchorRate 1.14174` against a stamped `fxSpot 1.14164` — one pip apart, so the anchor is
the spot mid — while their own `fxOutright` is 1.14417, a 25.3-pip points width away and exactly
the TP level the chart draws.
**Rejected:** a distance tolerance on `placementMarkFromTrail` (prefer the print when the anchor
is more than N pips from it). It broke three existing tests that deliberately pin an anchor 8–12
pips from the print, and no threshold works anyway: a 1M leg's points are ~14 pips, so any band
loose enough to keep those tests passing lets a short-tenor mismatch through.
**Corrected:** `placementAnchorRate` looked like it already solved this — it adds
`spotReferencedLegShift(t) ?? 0` — but that shift is null for a plain forward-tile order, which
carries neither `isSpotReferenced` nor `stripLegPoints`. It returned the raw spot anchor for
exactly the tickets in this report.
**Left open:** all three legs (M3.43, M6.86, M10.29) carry identical stamps and identical 25.3-pip
points. Different tenors should not share a points width; they were left from the spot tile in one
action, and whether that is correct is a separate question from where the pin is drawn.

## 2026-09-23 `fdcf7ef` fix(test-mode): the tile's chrome follows the selected leg, not the opened ticket

**Measured:** queried `sandbox_progress_uat` directly for the real ticket behind the report
(`stripId='strip-EUR-ht-mudsf1cy-y1aed3'`, edge 3). `bracketRole='takeProfit'`,
`orderHit='ask'`, and `restingOrderHitSide(ticket)` all agree at `'ask'` — the ticket data
was internally consistent throughout. Confirmed the mechanism against this real object with
a scratch vitest (`legPeersAtEdge`, `restingOrderHitSide`, `limitTakeProfitHit('Sell')`),
not by hand-tracing the render a third time: `limitTakeProfitHit('Sell')` returns `'ask'`,
so `selectedPadTicketForHit`'s bracketRole fallback for `hit='bid'` computes
`role='stopLoss'` and correctly finds nothing at this edge — the bid pad's blank/live
appearance was never a lookup bug. The `viewOnly` prop was.
**Rejected (twice, before the real fix):** two earlier hypotheses died on contact with real
data. First, that a malformed ticket (`orderType:'takeProfit'` with `bracketRole` unset)
explained the mismatch — a scratch test proved `orderHit='ask'`+`bracketRole` set produces
exactly the label/side pair seen, so I built the wrong fixture and confirmed the wrong
shape before checking the real one. Second, that `stripPadLive`'s formula was still
`restFilled || liveFilled` — it had already been corrected (commit `3171c0f`, same session,
not visible to me when I started) to `!restOpen && (selectedLegKey == null ||
selectedLegIsFree)`, which made my first patch attempt a no-op for the reported case; I
reverted it before it was committed.
**Corrected:** a claim I was about to make in this same investigation — that L4's
`bracketRole` was unset — was false. The DB shows every recent TP fill on this strip has it
set correctly. The real gap is `isSpotReferenced`, not `bracketRole`.
**Left open, order-booking logic, not touched:** every TP fill on this strip's most recent
booking (`filledAtMs` clustered ~2026-09-2x) has `isSpotReferenced: null` and no
`stripLegPoints`; the older strip on the same currency (`filledAtMs` ~9 days earlier) has
`isSpotReferenced: true` with real points on every TP leg. That flag is what lets
`legPeersAtEdge`'s `coverOnly` path recognize a spot-referenced bracket as the leg's own
trade (decisions.md, 2026-09-11) — its absence is why the priced-legs row (which calls
`legPeersAtEdge(..., {coverOnly:true})`) finds nothing at that edge and falls back to the
batch `execReport`, printing a shared side/dealer/rate across every row that lacks its own
cover match instead of each ticket's own. Not fixed: it's in ticket-creation code the user
told me not to touch this session without explicit confirmation.

## 2026-09-23 `4437617` fix(test-mode): an executed strip leg is not forced to a live quote

**Measured:** `stripPadLive` gates the tile's whole execution chrome —
`filledHit`, `executedHit`, `fillPx`, `padFillPx`, `fillRole` and `fillAt` are each passed as
`stripPadLive ? null : …`. Its last clause was `restFilled || liveFilled`, both of which read the
ticket that OPENED the panel.
**Corrected:** those two terms can only fire when `selectedLegIsFree` is false — the two clauses
before them already return true for "nothing selected" and "selected leg still tradable". So the
clause fired exclusively in the case where the selected leg HAS an execution or an order of its
own, which is exactly when the pad must show it rather than a live quote.
**Left open:** `filledHit` and `executedHit` still fall back to `restFilled || liveFilled` when
the selected edge has no market-executed ticket. That path reads the opening ticket and is the
same class of stale source; it is reachable for a bullet, where there is no edge to ask.

## 2026-09-23 `fcf2016` docs(decisions): record the per-writer journal and the owner segment

No finding beyond the commit message.

## 2026-09-23 `2a36baa` fix(storage): keep the journal on the server, scope data per desk

**Measured:** live against the local stack (Postgres + MinIO) with two `dev-login` users: bob's GET
and DELETE of alice's upload, `prefix=market-rates/`, an empty prefix and
`prefix=market-rates/alice@example.com` all 403; a guest journal GET 401; `\d execution_logs` and
`\d order_executions` showed the new `userEmail` column and index on the existing tables, and both
tables had held 0 rows before the test. In the Nexus cluster the root `values.yaml` on `main`
(written by `nexus-gh-app[bot]`, `e7e18a9`) has `s3.enabled: true`, `database.enabled: true`,
`redis.enabled: false`, and `S3_PREFIX` is injected without a trailing slash.
**Measured:** the old journal PUT upper-cased every tape key (`EUR|spot` → `EUR|SPOT`), so a reloaded
chart looked up a key that was never stored; it only did not show in `next dev` because dev never
reached the route.
**Rejected:** a union of the desk's and the matcher's tape per key on GET (round-1 review): while the
browser believes the matcher is down it walks its own series under the same key, and a union keeps
two walks interleaved for good. Per key, the matcher's series wins.
**Rejected:** a 16M-character PUT cap plus a 64-key cap (round 2): a working day of 1-second 6h tapes
is ~2M characters per currency, so a busy desk would get 413/400 on every later save, silently.
Replaced with a 64M cap and no key cap.
**Rejected:** new tables with an owner column instead of the guarded ALTER — leaves dead tables for
no gain, since rows without an owner are hidden either way (user chose to record the ALTER instead).
**Left open:** no on-screen indicator when the journal cannot load or save — only a one-time
browser console warning; `setup.md:12` still says "browser-only persistence" (project-knowledge
edit awaiting confirmation); the auth callback that builds a session from an unverified JWT or
`?email=` was spun off as its own task — every per-user boundary here depends on it; financial
fields still logged by the execution-log POST and runtime summaries (pre-existing).
**Corrected:** `README.md` said the real bucket can be reached locally with exported AWS credentials
— the Nexus team issues none (`#nexus-support`); `.env.example` said the same and was fixed too.
`check-database.md` section 7 said there was no answer for adding a column; it now points at the
2026-09-23 decision.

## 2026-09-23 `63f413a` fix(test-mode): a leg's tile shows that leg's own order type

**Measured:** the two symptoms the desk reported are one defect, and `grep -c` settles it. In the
merged tree `limitMode || restFilled` appears at four tile sites (`referenceLabel`, `bid`, `ask`,
the pad's own `limitMode`) plus a fifth inside `bracketSide`, and `restFilled` is
`ticket.status === 'booked' && ticket.limitRate != null` — a fact about the ticket that OPENED the
panel. There is exactly one `limitMode` `useState` for the whole panel. So the tile has one shape
for every leg, and which shape depends on how the desk arrived, not on the leg.
**Measured:** `origin/dev` had NOT fixed this. Before merging, `git show origin/dev:…/TradeTicketPanel.tsx
| grep -n "limitMode || restFilled"` returned lines 5872 / 5881 / 5882 / 5918. Upstream had renamed
`tileBid`/`tileAsk` to `selectedPadBid`/`selectedPadAsk` and added a partial patch
(`stripPadLive ? limitMode : Boolean(limitMode || restFilled)`), i.e. it moved the *quotes* per leg
and left the *shape* panel-wide. Worth knowing before assuming a rewrite of the same file fixed it.
**Rejected:** collapsing the tile to the simple shape whenever the toggle says market, which is the
literal reading of the first report ("switch to market … rendered as extended limit order tile").
The second report — opening a market order makes limit legs draw as market tiles — is the same
`restFilled` read pointing the other way, and a toggle-wins rule fixes one by deepening the other.
Per-leg resolution is the only rule that satisfies both.
**Rejected:** `coverOnly: true` on the `legPeersAtEdge` call, copied from the priced-legs row three
lines above. A bracket resting at an edge IS a limit order on that leg, and `coverOnly` hides it —
the tile would drop the sheet the desk needs to work that level from.
**Left open:** `padTicketForHit` still resolves from the opened ticket and its OCO sibling, not the
selected row. That is the same root cause one layer down, it is not fixed upstream either, and the
concurrent agent's in-progress fix for it is parked unmerged on `wip/tile-shape-and-pad` (`afecf9d`).
**Left open:** no regression test. The rule lives in a `useMemo` inside a ~7000-line render, the
same shape flagged as untested for `c93fbb6`'s pad fix; it was verified by reading the peer
resolution, not by a guard. Extracting the predicate to `lib/test-mode/` would make it testable.

## 2026-09-22 `b1e669c` fix(test-mode): a pad shows a fill only when its own order filled

**Measured:** ran the desk's real EUR book through the chain in a scratch vitest (the `@/` alias
needs vitest; a plain node script fails on it). `chartTicketsAtEdge` + `tapeOrderLevels` returned
both levels on every one of the 7 edges, each cancelled sibling flagged `cancelled: true`, on both
the bracket-focus and the `focus=null` path. So the level pipeline was already correct when the
chart still looked wrong — the remaining fault was elsewhere.
**Rejected:** falling back to the panel's own `fillPx`/`fillAt` when a pad resolves no ticket,
gated on `filledHit === hit`. It looks safe because that is the gate the badge itself uses, but
`filledHit` derives from `fillTicket`, not from the pad, so it reproduced the exact failure the
guard above it documents — a non-bracket LIMIT ticket's print rendered on the SL pad while the TP
pad showed the same print from its own ticket. Reverted; a comment at the site says not to retry it.
**Rejected:** reading the contradiction as a title bug. The titles were already right —
`padRoleIsTakeProfit` reads each pad's own `bracketRole`, the same authority the chart uses. Two
pads showing `STATUS —` under a `FILLED` badge was the tell that no pad's own ticket had executed.
**Corrected:** the misalignment reported across several rounds as a row-count problem was not one.
The badge block is `h-6` + `mb-1` and was rendered only when `filled || confirmed`, so the pad
without a badge started 28px higher — every row below it was offset. Equalising row counts could
not fix an offset that sits above the rows.
**Left open:** no cancellation timestamp exists anywhere. All three cancel paths write only
`{ ...t, status: 'cancelled' }`, and `HedgeTicket` has no `cancelledAt`. A cancelled-order pin on
the tape therefore cannot be built until one is stamped, and it would only ever work for
cancellations after that change — the tickets already on the book cannot be given one.

## 2026-09-21 `3a244d9` feat(test-mode): hold the tape's price window steady

No finding beyond the commit message — committed from a Claude Code session; the change is the
concurrent Cursor session's work, verified before committing (tsc clean, 70 tests in
tape-candles.test.ts) but not authored here.

## 2026-09-21 `9f7bcae` feat(test-mode): say which empty the draft seed hit

**Measured:** the data and every server layer are healthy for the booking that shows "did not
load" — 1,852 rows in each of the six legs' story windows, `loadLegTapeTicks` returns all 1,852
for `16:20:57 → 16:53:56` with `store: postgres`, and the route passes the window and normalises
the email to the one the rows are stored under. The failure is in the browser.
**Rejected:** a third blind fix. Two attempts were shipped on reasoning alone —
`fb1e2c3` (tenor matching, which resolves leg 1 for every row on a strip) and the earlier
`clipToStory` work — and neither was verified against the client before claiming the bug closed.
`seedDraftHistory` has two exits that both return `[]`, and no artefact distinguishes them.
**Left open:** the bug itself. This only makes the two empties tell themselves apart —
`draft-clipped-to-story` (window kept nothing) vs `draft-anchor-break` (rows arrived, one 40-pip
sample against `anchorMid` discarded the whole series, with the two prices and the gap in pips).
Reported through the existing `[tape-load]` sink, so it reaches the dev-server terminal.
**Corrected:** the first seed runs inside a `useState` initializer, before `logTapeLoad` is
defined in the same render — calling it directly is a TDZ throw, so the diagnostic goes through a
ref that the first seed leaves unset.

## 2026-09-21 `c93fbb6` fix(test-mode): the leg count the desk sets is the one that displays and books

**Measured:** querying `sandbox_progress_uat` directly (node + `pg`) showed the EUR book on task
02 holding seven legs under a *single* `stripId` — four covers and three take-profit brackets —
summing to exactly the target. That is why Book was inert: `canBook` is
`Math.abs(executeClip) > 1e-9` and the clip was zero. Reported as a dead button; it was arithmetic.
Separately, `leg_tape_ticks` held ~118k `EUR|spot` rows over 13 days and `spot_day_candles` ~1.6k
1m bars over 7 days, both current to the minute — so an executed trade's chart showing ~30 minutes
is `tapeLookback` defaulting to `'order'` (`tapeLookbackStartMs` returns `null`, the fetch effect
short-circuits), not missing data.

**Rejected:** letting a new strip *replace* a finished one via `mergeRollingStripIntoBook`.
Executed legs carry `status: 'booked'`, `isLiveHedgeTicket` counts those as live, and they feed
`bookedPositionOffsetsByCcy` / `stripCoverLocalM` / residual VaR. `order_executions` is read back
only by `orderId` and never rehydrates into the risk math, so replacement deletes real unsettled
cover from the only place exposure is computed. The rule proposed for it ("only if the old one is
done") selects precisely the case where everything deleted is a live position.
Also rejected: suppressing the finished strip as peers so the modal shows free legs — the matcher
enforces the same constraint server-side through `stripCoverSlot` = `ccy|edge` and
`isDuplicateStripCoverRest`, so the legs would look tradeable and their orders would be dropped.
Also rejected: narrowing `hasRollingStripForCcy` to exclude cancelled tickets, which the plan
called for — auditing its 18 call sites first showed `removeHedgeTicketOrStrip` filters cancelled
tickets out of `booked` entirely, so the state it guarded against cannot occur.

**Corrected:** two claims of my own, both made from pattern-matching rather than measurement.
(1) I reported the repeating `[fx-exec] leg tape DB persist ok: 6 points` line as a stuck buffer.
`MATCHING_HEARTBEAT_BEATS = 6` and the flush rides the heartbeat tick, so ~1 tick/sec × 6 points
per 6 ticks predicts 60 rows/min; measured 58 in the last 60s, all distinct timestamps. A repeated
log line is not evidence of a leak until the interval producing it is checked.
(2) I described the EUR book as "two interleaved ladders". All seven legs share one `stripId`;
the second group is take-profit brackets. Both corrections were one query away.

**Left open:** booking clears the staged package in memory, but the resulting save is refused by
`hedgeBookLooksLikeAccidentalWipe` (`lib/hedge-book-normalize.ts:407`, `ex.prepared > 0 &&
inc.prepared === 0`; `:411` rejects any reduction), so memory and Postgres disagree and a reload
resurrects the ladder. The guard cannot distinguish a deliberate clear from an accidental one, and
any legitimate reduction in staged packages is dropped with it.
`varApprovalRequired` — the policy VaR rungs — runs only in the browser; `app/api/desk/route.ts`
is 72 lines, does `auth()`, and writes `prepared_by_ccy` without inspecting `approvalStatus`, so a
request asserting `'approved'` is accepted regardless of size.
`sourcePackage` stamps on the seven legs of that one ladder disagree on `coverLocalM` (four
different values), and `stripPackageForTicketView` resolves by "largest stamp wins", so the ladder
the UI shows depends on which leg it is opened from. Every stamp has `approvalStatus: null` — the
approval exists only on `preparedByCcy`, never on the booked record.
The `padFillPx` fix here has no test: it sits in a `useMemo` inside a ~7k-line render and was
verified by replaying real values, not by a regression guard. That defect had already recurred
once — the comment above it names the exact rate and clock it reproduced.
Four sites in this commit are the same shape (a value written in one place, read from another):
the booking modal's schedule-versus-count precedence, the hedge-profile stepper writing state
nothing reads, the card's staged-package-versus-draft ordering, and a hard-coded default
overwriting a carried count. Fixing them one at a time has not stopped the shape recurring; no
decision record covers ownership of the ladder.

## 2026-09-21 `ec9661c` fix(test-mode): an order with no resting level is a MARKET order

**Measured:** the offending ticket, read from `sandbox_progress_uat`, has `filledAtMs` and
`orderHit` set, `limitRate` null, and **no `status` key at all** — `composeDecisionBookTicket`
creates without one and `sendPreparedToDecision`'s bullet branch (fixed in the same session) never
stamped it. A `->>` query cannot tell an absent key from a JSON null, which briefly read as
`status: null` and sent me looking for code that writes null; the key is simply missing.

**Left open:** `isMarketExecutedHedgeTicket` also requires `status === 'booked'`, so a ticket in
this shape stays invisible to peer matching, executed-leg resolution and strip-completion checks
while the blotter shows it FILLED. The label now classifies correctly, but tickets already
persisted in that state are unchanged — this fix stops new ones, it does not repair the book.


## 2026-09-19 `dc783fc` fix(test-mode): a strip row's fill chrome follows its own edge

**Measured:** replaying the resolution against the live book's six EUR strip legs now returns six
distinct tickets — edge 0 `L1 · M2` Citi 1.15227 (market), edge 3 `L4 · M8` JPM 1.16026, edge 5
`L6 · M12` HSBC 1.16597 — where the tenor-matched version returned edge 0's ticket for all six.
**Corrected:** the previous fix (`fb1e2c3`) claimed to follow the selected row. It matched on
tenor through `legTicketForSelectedLeg`, whose `atTenor` short-circuits to true whenever
`chartLegInstrument` is 'spot' — which is always, because a strip opens on the spot tile. Every
row resolved leg 1, so the bug it was written to fix survived for every leg but the first.
**Left open:** `coverOnly` still refuses a bracket-only edge. Five of the six legs here are
stop-loss fills, so the tile reaches them only through the non-coverOnly fallback; a legacy
non-spot-referenced spot bracket would therefore print its spot price under a forward label, the
case `coverOnly` exists to prevent. Confining fallbacks to the edge bounds the damage to one row
instead of showing a neighbour's, but does not resolve which question the tile should ask.

## 2026-09-19 `f6392ef` fix(test-mode): one strip per CCY, and a caption that matches its rows

No finding beyond the commit message — committed from a Claude Code session; the change is the
concurrent Cursor session's work, verified before committing but not authored here.

## 2026-09-19 `2ff7009` fix(test-mode): a filled tile shows that leg's own execution

**Measured:** the book holds `L1 · M2 Citi 19:50:49 outright 1.15227` and
`L4 · M8 JPM 19:50:55 outright 1.16026`. The tile rendering M8 showed header
`FILLED · 19:50:49 · CITI · REF 1.16060`, SELL `1.15222` under JPM and BUY `1.16006` under CITI —
the M2 leg's time, dealer and rate on the M8 tile, banks crossed, and a REF matching no stored
execution. The two numbers were 784 pips apart, which is not a spread.
**Rejected:** reconstructing the counter side as executed ± spread. The spread at the moment of
execution is not stored either, so the number would be invented and would sit on an execution
record where it reads as fact.
**Left open:** `HedgeIpaQuote` keeps `fxSpot` and `fxOutright`, never a bid/ask pair, so no leg
booked so far can show a historical counter-side quote — that side now reads `—`. Stamping both
sides at fill is a booking-path change and is not done here; it would only help future fills.
**Corrected:** the comment above the filled badge in `components/test-mode/TradeTicketPanel.tsx`
claimed "Dealer and REF describe the EXECUTION ... never the typed tile". REF read the live
`bid`/`ask` props, so it drifted with the market after the fill and disagreed with the rate
printed under it.

## 2026-09-19 `06d9e9f` fix(test-mode): a bar after a recording gap opens at its own print

**Measured:** a LAG scan over `leg_tape_ticks` for the last 48h found 72 jumps >10 pips on
`EUR|spot`. Two are recording joins, not moves: `21:04:53 → 21:25:39` is +55.4 pips after an
87,646s gap, and `18:08 → 22:03` in `spot_day_candles` is +12.9 pips after 235 minutes. The 33-pip
cliff the desk reported is a single tick, `14:58:45 1.15252 → 14:58:46 1.14923`, three hours after
a restart wrote `1.17010` into the tape (`11:47:00 1.14999 → 11:47:20 1.17010`, then −172.0 pips
one second later) — the walk had been mean-reverting around a stale anchor until the first fresh
live print snapped it back.
**Rejected:** detecting the break from the price jump. `dropTapeConventionBreak` already does that
for spot-vs-outright contamination at 40 pips, and reusing it here would have deleted the market's
own fast moves. The gap is a fact about TIME between bars, so `tapeCandleGaps` keys on bar spacing
and says nothing about price.
**Left open:** the chart still draws the two segments shoulder to shoulder — with chaining gone
the fabricated candle is replaced by an unexplained step. The whitespace band and the dashed join
that make a break read as a break are not written yet.
**Corrected:** `aggregateTapeCandles`' own test "starts each new candle at the previous close"
described chaining as unconditional. It is now conditional on adjacency, and the test file says so.

## 2026-09-14 `246f9a9` feat(skills): compose and open the pull request from the branch's evidence

**Measured:** nothing in the repo created PRs — `grep -rn "gh pr create" .claude/` returns nothing,
and there is no `.github/PULL_REQUEST_TEMPLATE.md`. `gh pr list` shows 4 open Dependabot PRs, the
oldest from May, which is the same gap seen from the other side.
**Rejected:** adding a PR template. `.github/` is platform-managed and must not be changed, so the
shape lives in the skill instead.
**Left open:** the skill cannot push — `settings.json` denies `Bash(git push*)` — so a branch with
no upstream gets the command handed back rather than a composed body `gh pr create` would refuse.

## 2026-09-14 `2c5f084` feat(skills): log what each commit taught, in docs/knowledge-log.md

**Measured:** `PostToolUse` reaches the model only through
`hookSpecificOutput.additionalContext` on stdout with exit 0; exit 2 does **not** block there
because the tool has already run. The matcher keys on tool name only, so `git commit` has to be
recognised from `tool_input.command` inside the script. Confirmed against the official hooks
reference before any of it was built on.
**Measured:** the case for a hook rather than prose — 280 commits on `dev` in 90 days, 10 of which
touched `decisions.md` (~4%), against a median commit body of 12 lines. The first number says
prose gets skipped; the second says a per-commit summary that paraphrases the message would be
pure noise.
**Rejected:** putting the journal in `.claude/rules/project/`. It would have required weakening
`engineering.md`'s enforced "never speculatively fill in a project/ md file without explicit
confirmation" — the rule that stops an agent inventing project knowledge. Moving the file to
`docs/` gets the feature without touching the rule. The cost is that `/project-commit` does not
carry it to GDrive.
**Left open:** the hook only sees commits made through an agent's Bash tool — a terminal or Cursor
commit never reaches it. Not ported to Cursor: its after-shell event is unverified, and a guard
nobody has watched fire is worse than a documented absence.
