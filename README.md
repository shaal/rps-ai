# Adaptive RPS

Rock–paper–scissors against an opponent that stores every round as a vector
memory and gradually learns to read you.

It runs entirely in your browser. No server, no account, no API keys, nothing
leaves the machine — the opponent, its memory and its maths are all client-side,
and the whole thing deploys as static files. Memory lives in IndexedDB and is
**yours**: it persists across visits, so it recognises you when you come back.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
```

Throw with the buttons or the **R / P / S** keys (switchable off — they are
unmodified single-key shortcuts, which WCAG 2.1.4 wants escapable).

```bash
npm run build      # static export to ./out
npm run preview    # serve the built files
```

There is nothing to download on first run and no warm-up: the encoder is a few
hundred lines of arithmetic, and a round costs well under a millisecond.

## How a round works

The AI picks its move **before you throw**, and publishes a hash of it.

**Commit** — as soon as the page loads, and again after every round:

1. **Builds a context string** from the history so far.
2. **Encodes it** to a 57-dimension unit vector (`lib/feature-embed.ts`).
3. **Searches** memory for the `k = 12` nearest past situations — an exact
   cosine scan, not an approximate index.
4. **Aggregates** what you played next in those situations, weighting each
   memory by three independent signals, then mixes in how often you throw each
   move at all (below).
5. **Puts that to a panel** of rival predictors, each weighted by how well it
   has been calling your throws lately.
5. **Picks a move**, keeps it with a random nonce, and surfaces only
   `sha256(move + ":" + nonce)`.

**Resolve** — when you throw:

6. Opens the commitment, resolves the outcome, **records the episode**, and
   hands back the move *and* the nonce so the page can recompute the hash and
   check it against what it displayed earlier.

A brand-new browser throws at random until it holds `MIN_MEMORY_FOR_ADAPTIVE`
episodes. After that it reads you from the first throw of every visit —
including the opening, because "this person is starting a fresh session" is
itself a situation it has seen before.

### What the commitment does and does not prove

It shows the revealed move is the one already chosen when the hash was handed
over: it cannot have been swapped after seeing your throw. The page recomputes
the SHA-256 itself and shows a pass/fail badge.

It does **not** prove anything about honesty. When this was a server game the
seal and the check sat on opposite sides of a network, which made the check mean
something. Now both halves run in the same browser, so anyone who can edit the
page can edit both. It is a working demonstration of commit-and-reveal, not a
guarantee, and the UI says exactly that.

What is still real is the **sequencing**, which is what the game actually needs:
the move exists before the throw, and looking at it does not re-roll it.

| Case | Behaviour |
|---|---|
| Replaying a spent `commitId` | Rejected — one shot only |
| An older commitment after a newer one | Rejected — newest wins |
| Memory reset while a commitment is open | Rejected as stale |
| Expiry (30 min) or a reload | Rejected, silently re-committed |

### The instrument: Hindsight and Foresight

The left column is the game — score, throws, telemetry. Everything the AI is
thinking lives in one panel on the right, which flips between two faces:

- **Hindsight** (default) — how it read the round you just played.
- **Foresight** — the move it has already sealed for the round you are about to
  throw, so you can beat it every single time.

These were two separate panels once, which put two different rounds on screen
simultaneously and made their confidence figures look contradictory. They were
never inconsistent — they were one round apart. Showing exactly one round at a
time removes the problem by construction instead of labelling around it.

**Looking does not change the answer.** Peeking reads the sealed commitment
without consuming or replacing it. An earlier design re-committed with a
`revealed` flag, which minted a fresh move and a fresh hash every time you
flipped — so peeking silently re-rolled what the AI was about to play and
invalidated a hash already on screen.

The current view is passed to the commit step as a hint, purely so the Level
controller can stop steering against a player who can see its hand. It is read
from a ref rather than a dependency, so flipping never triggers a re-commit.

### The context string is coded, not prose

```
H:S>R>P>S>R>P A:S>R>S>S st:P1 out:L,W,D bg:PS,SR,RP fq:R2P2S2
```

`H` = your recent moves, `A` = the AI's, `st` = your current streak, `out` =
recent outcomes, `bg` = your last three transitions (order, which raw
frequencies lose), `fq` = move frequencies. The round number is deliberately
absent — it is unique per episode and would inject pure noise.

This format was invented to survive a sentence transformer: natural prose maps
near-identical English templates into a very tight cosine ball, flattening the
distance signal until inverse-distance weighting is weighting noise, and dense
coded slots clawed the contrast back.

In hindsight that need was the tell. **A format invented to survive an embedding
model was already a feature vector**, and it only ever had to be parsed rather
than translated. `feature-embed.ts` now reads these slots directly — no model,
no download, ~0.004ms per encode. The measured effect on the thing that actually
matters, the separation between situations:

| | Sentence transformer | Feature encoder |
|---|---|---|
| Identical contexts | 1.0000 | 1.0000 |
| One move different | **0.9934** | **0.6978** |
| Unrelated | 0.0829 | 0.0082 |

The transformer scored a near-miss at 0.9934 against an exact match's 1.0 —
almost indistinguishable, which is precisely the signal k-NN needs. The UI still
shows the string verbatim, because it is still the actual query.

One subtlety that bit: an opening — no moves, no streak, no outcomes, all
frequencies zero — encoded to the **zero vector**, which has distance 1.000 to
everything. The one situation a returning player is guaranteed to be in could
retrieve nothing. A two-dimension phase block (`opening`, `depth`) fixes it, and
is why the vector is 57 wide rather than 55.

### Weighting

```
weight = 1/(ε + d²)  ×  exp(−age / 150)  ×  (1 + trailing-move match)
```

- **Inverse squared distance** — how similar the situation was. `ε = 0.01`
  stops an exact match from taking effectively infinite weight.
- **Recency decay** — old habits fade, so switching strategy actually works.
  Age is measured against a counter that only ever climbs, deliberately not
  against the number of episodes held: those agree until the 5000-episode
  retention cap, after which the size freezes, every age collapses to zero and
  decay would silently stop existing.
- **Trailing-move match bonus** — a hybrid re-rank against your literal last
  moves.

### The base rate

That vote answers "what did you do after situations like this one". For a
player whose next move does not depend on the situation it is the wrong
question, so the result is mixed with a straight tally of how often you throw
each move (`lib/prior.ts`):

```
P = (1 − w) × memory vote  +  w × base rate

w = (1 − memory confidence) × prior strength
```

The tally is an exponential moving average with a ~100-round window, so a
change of habit is followed rather than averaged against everything before it.
Both terms in `w` are load-bearing. Confidence alone would hand the vote to the
base rate exactly when a player switches strategy — the moment the memory is
*correctly* unsure and the tally is a stale average of two regimes. **Prior
strength** is the guard: total variation distance from uniform, saturating at a
50/25/25 split, so a base rate with nothing to say stands down instead of
shouting. Below that saturation point the deviation is within a few standard
errors of what shuffling produces at this sample size.

### The committee

All of the above is still one hypothesis: that your next move is a function of
the recent situation. That is right about a lot of players and wrong about
several common ones, and when it is wrong no amount of encoder tuning rescues
it, because the question being asked does not have the answer in it.

So the memory is one voice on a panel (`lib/experts.ts`). Beside it sit four
one-line hypotheses — you repeat, you rotate, you keep a winning move, you play
what would have beaten the AI's last throw — and each round every member states
a distribution. They are mixed in proportion to how well each has been calling
your throws lately, using exponential weights.

Three details carry the result:

- **A share floor.** Plain exponential weights are optimal against a *fixed*
  best expert: one that spends sixty rounds wrong decays to zero and can never
  climb back, since its weight multiplies. Since the entire premise is players
  who change, every member keeps a 1% stake and can be back at parity about
  three rounds after it starts being right.
- **Voting is sharper than tracking.** Standings are raised to a power before
  they become vote shares. Tracking wants to be forgiving so a newly-correct
  member is noticed; voting wants to commit, because a vote split across five
  predictors that are each barely better than chance is worse than the best one
  alone.
- **The heuristics stand down against a memoryless player.** Every one of them
  asks "given what just happened, what follows", so all four are useless against
  someone whose next move does not depend on what just happened. `repeat` is the
  trap: against a 60%-rock player it is right 44% of the time, comfortably
  beating chance and clearing any track-record bar, while being far worse than
  simply always saying rock — and it drags the vote off rock every time that
  player throws something else. A skewed base rate is precisely the signal that
  a player is memoryless, so the same **prior strength** above scales the
  heuristics down. Without that gate the committee cost 3.4pp against that
  player; with it, 0.2pp.

The base rate is deliberately not a member of its own. It is already inside the
memory's distribution, and running it again as an independent voice measured
identically while counting the same evidence twice under two names.

### Confidence is not theater

```
confidence = margin × support × maturity

margin  = (top − runner-up) / (top + runner-up)
support = (Σw)² / Σw²          — effective sample size
```

Any one of those being weak caps the number, and the panel shows the raw inputs
(`neighbors`, `margin`, `support`, `avg distance`) so it can be checked rather
than believed. Support guards against a single memory masquerading as consensus;
margin goes to zero when two moves tie.

Two things are deliberately *not* in that formula:

- **No absolute-distance term.** An earlier version multiplied by
  `1 − meanDist/0.5`, which sounds principled and is not: with distances in
  [0.001, 0.09] it stays pinned between 0.82 and 1.0 and never rejects a bad
  neighbourhood. It looked like a signal while measuring nothing.
- **No top-share term alongside margin.** Both measure the same lopsidedness, so
  multiplying them double-counts it. Margin is also the sharper discriminator: a
  top share of 0.4 could be a clear winner or a three-way tie; margin is near
  zero on the tie.

### Modes steer the score, not the difficulty

There is no difficulty dial. The prediction runs at full strength in all three
modes — what changes is what the AI *does* with a correct read.

| | It plays | Result |
|---|---|---|
| **Dominate** (default) | `counter(X)` | Wins every round it reads correctly |
| **Level** | steered | Holds the score near a tie |
| **Yield** | `BEATS[X]` | Throws rounds on purpose |

Given a predicted human move X, the AI can aim at any outcome: `counter(X)`
beats it, `X` draws with it, and `BEATS[X]` loses to it. For read accuracy `p`,
the expected score change per round is:

```
win  intent →  (3p − 1) / 2
draw intent →  0, for any p
lose intent → −(3p − 1) / 2
```

Two things follow. **Authority is zero at p = 1/3**: a reader no better than
chance cannot steer the score at all — Yield can only throw a match it can
actually read. And **draw intent is score-neutral at any p**, which makes it the
correct hold action for Level, rather than "play honestly" (which drifts the
score upward).

Level runs a proportional-integral controller on the score error with a
deadband, so it does not thrash around parity. It stops steering when the read
is too weak to act on, and when you have Foresight open — correcting for a
player who can see your hand just escalates to maximum aggression under a label
that promises an even game.

Even in Dominate the AI samples rather than always countering its top read, and
throws at random 5% of the time. Pure argmax makes it a fixed function of the
history, which a human detects in about ten rounds and then counter-counters —
so a little noise is stronger play, not weaker.

## Measured behaviour

Reproduce with `npx tsx scripts/bench-encoder.ts` — it drives the real encoder
and the real weighting against scripted opponents, and reports how often the
next human move was predicted correctly. 250 rounds per run, first 20 discarded,
averaged over 10 seeds. Chance is 33.3%.

`freq` is a deliberately trivial baseline: predict whatever this player has
thrown most often. If the vector memory cannot beat that, it is not earning its
complexity.

`blend` is the memory vote with the base rate mixed in, `panel` adds the
committee on top, `gain` is what the committee bought, and `mem` is the memory's
own share of that committee vote. Both predictors are scored on the same games,
so the columns are a like-for-like comparison rather than numbers from separate
runs.

| Opponent | blend | panel | freq | gain | mem |
|---|---|---|---|---|---|
| cyclic `R>P>S` | 100.0% | **100.0%** | 33.5% | +0.0pp | 97.6% |
| win-stay lose-shift | 100.0% | **100.0%** | 33.5% | +0.0pp | 93.5% |
| reacts to the AI's last move | 100.0% | **100.0%** | 0.0% | +0.0pp | 92.7% |
| frequency-biased (60% rock) | 58.9% | 58.7% | **59.3%** | −0.2pp | 90.9% |
| switches strategy at halfway | 96.1% | **98.3%** | 33.0% | **+2.2pp** | 91.1% |
| restless (new tactic every 25) | 89.1% | **91.3%** | 36.1% | **+2.2pp** | 90.1% |
| genuinely random | 32.8% | 33.4% | 33.9% | +0.6pp | 8.4% |
| **mean** | 82.4% | **83.1%** | 32.8% | | |

Five things worth reading off that table.

**It recovers from a strategy change.** The switching opponent still lands at
96.5%, which is the answer to the obvious worry about a high-contrast metric:
that only near-exact histories match and a change of tactics leaves the AI
confidently wrong. Recency decay handles it.

**It does not manufacture competence.** Against genuinely random play it sits at
chance, where it belongs.

**It no longer loses to a trivial baseline.** This was the one real weakness the
benchmark found, and it was structural. A player who is 60% rock has no pattern
to retrieve — only a marginal bias — so k-NN went looking for structure in noise
while counting-the-most-common-move simply exploited it. The gap grew with data
(−4.9pp at 150 rounds, −7.7pp at 250), which is the signature of a wrong
question rather than a small sample: twelve neighbours never stop being noisy,
while a tally keeps converging. Mixing the base rate into the vote closes it to
−0.4pp, and takes genuinely random play from −1.1pp to level.

**The blend costs nothing anywhere else**, which is a design property rather
than a lucky result. A uniform prior shifts all three moves equally and so
cannot change which one wins; against an unbiased opponent it is arithmetically
inert no matter how much weight it carries. It only bites when there is a real
bias to exploit.

**The committee earns its keep only on players who change**, which is exactly
what it was added for and nothing else. It is worth +2.2pp against both the
opponent that switches tactics once and the one that switches every 25 rounds,
and worth precisely nothing against the four that never change — the memory
already reads those at 100%, and there is nothing left to add. The honest
reading of the `gain` column is that this is a narrow fix for a specific
failure, not a general improvement.

One caveat on all of these: scripted opponents demonstrate the mechanism, they
do not say anything about humans. Against someone actively trying to vary,
expect something closer to 45–55%. This AI is not going to crush you — it is
going to know you slightly better than chance, and show its working while it
does.

### What this benchmark does not answer

It compares the current encoder against a frequency baseline. It does **not**
compare it against the sentence transformer it replaced, because that path was
deleted. The switch was justified on cosine separation — a proxy — and the claim
that it *predicts* better than MiniLM on the same opponents remains unmeasured.

## Layout

```
app/
  page.tsx              static shell
  layout.tsx            fonts, metadata
  globals.css           design tokens, throw buttons, flip, popovers
lib/
  rps.ts                pure game logic + the context builder
  feature-embed.ts      context string → 57-d unit vector   ← the encoder
  predict.ts            pure weighting, confidence, sampling
  prior.ts              base-rate tally and how far to trust it
  experts.ts            the committee: rival predictors, weighted by results
  score-control.ts      pure intent controller for Level and Yield
  commit.ts             pending commitments, hashing, one-shot semantics
  engine.ts             store lifecycle, commit and resolve
  memory-store.ts       the storage interface  ← swap point
  browser-store.ts      IndexedDB implementation of it
  config.ts             thresholds shared by engine and UI
scripts/
  bench-encoder.ts      headless prediction benchmark vs scripted opponents
components/
  game.tsx              state, commit lifecycle, hash verification, keyboard
  instrument-panel.tsx  the flipping Hindsight / Foresight panel
  proximity-scope.tsx   the radial memory readout, shared by both faces
  telemetry.tsx         stats, read-rate sparkline, recent rounds
  explainer.tsx         the "?" popovers
```

`lib/memory-store.ts` was written for a native vector engine writing files on a
server, and its docblock said swapping in a backend "for a runtime that cannot
load native addons" would mean one new class and one changed factory call. That
turned out to be exactly true: the port to the browser did not touch it.

## Deploying

Static files. `npm run build` emits `./out`, around 1.1MB, hostable anywhere —
Cloudflare Pages, GitHub Pages, S3, Netlify:

```bash
npm run build
npx wrangler pages deploy out
```

No server component, so nothing needs a Node host, a container, or a paid plan.

## Memory, resetting and exporting

Memory is per browser profile, in IndexedDB, and persists until you clear it. A
different browser — or someone else on the same machine — meets a blank
opponent.

**Reset AI memory** erases every episode (two-step confirm).

**Export memory** downloads newline-delimited JSON, one episode per line, at
about 194 bytes each.

Vectors are deliberately omitted from the export. They are deterministic
re-encodings of `context`, so the metadata alone is enough to rebuild the
memory. That is also why nothing but metadata is persisted at all: the working
matrix is rebuilt by re-encoding on load, which removes any chance of stored
vectors drifting out of step with the episode list.

## Accessibility

Targets WCAG 2.2 AA, verified with axe-core at 320/390/768/1440px plus manual
keyboard testing — 0 violations across both instrument faces, every popover, and
the reset confirmation.

Three that are easy to get wrong, and were: throw buttons use `aria-disabled`
rather than `disabled`, because a disabled button leaves the tab order and threw
focus back to `<body>` on every single round. Hover styles sit behind
`@media (hover: hover)`, because touch browsers park `:hover` on the last thing
you tapped and never clear it. Type is sized in `rem`, so the browser's own
font-size setting actually does something.

**Known issue:** at a 320px viewport combined with a 24px root font, the page
overflows horizontally by 29px — the throw label "SCISSORS" cannot shrink or
wrap. Clean at every wider viewport, and at root sizes up to 22px.
