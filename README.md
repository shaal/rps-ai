# Adaptive RPS

Rock–paper–scissors against an opponent that stores every round as a vector
memory and gradually learns to read you. Memory survives page refreshes and
server restarts.

Built on [RuVector](https://www.npmjs.com/package/ruvector) — a local ONNX
sentence embedder (`all-MiniLM-L6-v2`, 384d) plus a native vector database,
persisted to `./data/rps-memory.db`. No external AI APIs, nothing leaves the
machine.

## Running it

```bash
npm install
npm run dev
```

Open http://localhost:3000. The **first ever run downloads ~23MB** of ONNX model
from HuggingFace into `~/.ruvector/models`; the UI shows a "Loading model" state
while that happens. Later starts take 1–2s.

Throw with the buttons or the **R / P / S** keys.

## How a round works

The AI picks its move **before you throw**, and publishes a hash of it.

`POST /api/commit` — runs as soon as the page loads and after every round:

1. **Builds a context string** from the history so far.
2. **Embeds it** with `OnnxEmbedder`.
3. **Searches** the vector store for the `k=12` nearest past situations.
4. **Aggregates** what you played next in those situations, weighting each
   memory by three independent signals (below).
5. **Picks a move**, stores it server-side with a random nonce, and returns only
   `sha256(move + ":" + nonce)`.

`POST /api/round` — when you throw:

6. Opens the commitment, resolves the outcome, **records the episode**, and
   returns the move *and* the nonce so the browser can recompute the hash and
   check it against what it was shown earlier.

The first 5 rounds are thrown blind so there is something to bootstrap from.

### What the commitment does and does not prove

It proves the revealed move is the one the AI had already chosen when it handed
over the hash — it cannot have been swapped after seeing your throw. The page
recomputes the SHA-256 itself and shows a pass/fail badge.

It does **not** prove the server is honest in general. A rigged server could
always have committed to a rigged move in the first place. The UI says so
rather than claiming "provably fair".

Worth being clear: the AI never had access to your move even before this change
— `think()` only ever received history ending before your throw. The two-phase
flow makes that checkable instead of something you have to take on faith.

Hardening, because a commitment scheme with holes is worse than none:

| Case | Behaviour |
|---|---|
| Replaying a spent `commitId` | Rejected — one shot only |
| An older commitment after a newer one | Rejected — newest per session wins |
| Another session's `commitId` | Rejected |
| Memory reset while a commitment is open | Rejected with `stale-memory` |
| Expiry (30 min) or a server restart | Rejected, client silently re-commits |

### The instrument: Hindsight and Foresight

The left column is the game — score, throws, telemetry. Everything the AI is
thinking lives in one panel on the right, which flips between two faces:

- **Hindsight** (default) — how it read the round you just played.
- **Foresight** — the move it has already sealed for the round you are about to
  throw, so you can beat it every single time. Verified: a scripted player that
  looks and counters wins **30/30 in all three modes**.

These were two separate panels once, which put two different rounds on screen
simultaneously and made their confidence figures look contradictory. They were
never inconsistent — they were one round apart. Showing exactly one round at a
time removes the problem by construction instead of labelling around it.

**Looking does not change the answer.** Foresight calls `POST /api/peek`, which
reads the sealed commitment without consuming or replacing it. An earlier design
re-committed with a `revealed` flag, which would have minted a fresh move and a
fresh hash every time you flipped — so peeking would have silently re-rolled
what the AI was about to play and invalidated a hash already on screen. Now the
commitment is created once per round, the flip only opens it, and the hash in
the stage strip is unchanged by flipping. Ten tests cover this, including
repeated peeks returning the same move, the commitment still resolving
afterwards, and the hash still verifying.

While Hindsight is showing, the server sends only the hash, so a glance at the
network tab cannot spoil an ordinary game. That is spoiler control, not
security — you can obviously call `/api/peek` yourself.

The current view is also sent to `/api/commit` as a hint, purely so the Level
controller can stop steering against a player who can see its hand. It is read
from a ref rather than a dependency, so flipping never triggers a re-commit.

### The context string is coded, not prose

The obvious approach is a natural-language context like
`"Recent moves: Paper → Rock → Paper. Current streak: 2 Papers."` That performs
badly. A sentence-transformer maps near-identical English templates into a very
tight cosine ball, so the distances flatten out and inverse-distance weighting
ends up weighting noise.

This uses dense coded slots instead, which maximises lexical contrast between
genuinely different situations:

```
H:S>R>P>S>R>P A:S>R>S>S st:P1 out:L,W,D bg:PS,SR,RP fq:R2P2S2
```

`H` = your recent moves, `A` = the AI's, `st` = your current streak, `out` =
recent outcomes, `bg` = your last three transitions (order, which raw
frequencies lose), `fq` = move frequencies. The round number is deliberately
absent — it is unique per episode and would inject pure noise.

The UI shows this string verbatim, because it is the actual query.

### Weighting

```
weight = 1/(ε + d²)  ×  exp(−age / 150)  ×  (1 + trailing-move match)
```

- **Inverse squared distance** — how similar the situation was. `ε = 0.01`
  stops an exact match from taking effectively infinite weight.
- **Recency decay** — old habits fade, so switching strategy actually works.
- **Trailing-move match bonus** — a hybrid re-rank against your literal last
  moves. In this tight embedding space that signal is more reliable than the
  vector distance alone, and it is a large part of what carries the prediction.

### Confidence is not theater

```
confidence = margin × effective sample size × maturity

margin = (top − runner-up) / (top + runner-up)
eff. N = (Σw)² / Σw²
```

Any one of those being weak caps the number, and the panel shows all the raw
inputs (`neighbors`, `margin`, `eff. N`, `mean dist`) so it can be checked
rather than believed. Effective N guards against a single memory masquerading as
consensus; margin goes to zero when two moves tie.

Measured, over the last 20 adaptive rounds: **0.67** against a predictable
player it reads 100% correctly, **0.20** against a random one. It moves with
whether the read is real.

Two things are deliberately *not* in that formula:

- **No absolute-distance term.** An earlier version multiplied by
  `1 − meanDist/0.5`, which sounds principled and is not: with distances in
  [0.001, 0.09] it stays pinned between 0.82 and 1.0 and never rejects a bad
  neighborhood. It looked like a signal while measuring nothing.
- **No top-share term alongside margin.** Both measure the same lopsidedness,
  so multiplying them double-counts it and understates a read that is genuinely
  working (0.39 where 0.67 was right). Margin is also the sharper discriminator:
  a top share of 0.4 could be a clear winner or a three-way tie; margin is near
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
beats it, `X` draws with it, and `BEATS[X]` — the move X defeats — loses to it.
For read accuracy `p`, the expected score change per round is:

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
is too weak to act on (steering on a bad prediction pushes the score the wrong
way about as often as the right way), and when you have the reveal panel open —
correcting for a player who can see your hand just escalates to maximum
aggression under a label that promises an even game.

Measured over 75 rounds against a predictable player (99% read):

| Mode | Human | AI | Draws | Peak gap |
|---|---|---|---|---|
| Dominate | 10 | 57 | 8 | 47 |
| Level | 12 | 11 | 52 | **1** |
| Yield | 49 | 11 | 15 | 38 |

Against a *random* player all three land within ±5 of parity, exactly as
`(3p − 1)/2` predicts once `p` falls to chance.

Even in Dominate the AI samples rather than always countering its top read, and
throws at random 5% of the time. Pure argmax makes it a fixed function of the
history, which a human detects in about ten rounds and then counter-counters —
so a little noise is stronger play, not weaker.

## Measured behaviour

Against a scripted player, mode `dominate` unless noted:

| Scenario | Result |
|---|---|
| Predictable `R>P>S` cycle, 90 rounds | read rate **87% → 100%** (chance is 33%) |
| Strategy switch mid-game | 100% → **27%** immediately after the switch → 88% → **100%** |
| Genuinely random player | read rate **30%** ≈ chance, human 26 / AI 23 |
| Confidence | **0.67** on a perfect read vs **0.20** on random play |
| Using Foresight and countering | human wins **30/30**, in all three modes |

The strategy-switch row is the interesting one: recency decay means it goes
blind when you change tactics, then re-learns you.

The random-player row matters too — it does not manufacture false competence
against play that genuinely has no pattern.

One caveat on all of these numbers: they come from *scripted* players, which is
a demo of the mechanism rather than evidence about humans. Against someone
actively trying to vary, expect something closer to 45–55%. This AI is not going
to crush you — it is going to know you slightly better than chance, and show its
working while it does.

## Layout

```
app/
  page.tsx              server shell, kicks off model warmup
  api/commit/route.ts   lock in the next move, return only its hash
  api/peek/route.ts     disclose the sealed move without consuming or changing it
  api/round/route.ts    open the commitment against a throw, record the episode
  api/status/route.ts   warmup state, memory size, engine info
  api/reset/route.ts    erase all memory
  api/export/route.ts   download every episode as newline-delimited JSON
lib/
  rps.ts                pure game logic + the context builder
  predict.ts            pure weighting, confidence, sampling
  score-control.ts      pure intent controller for Level and Yield
  commit.ts             pending commitments, hashing, one-shot semantics
  engine.ts             singleton store, commit and resolve
  memory-store.ts       the storage interface  ← swap point
  ruvector-store.ts     RuVector implementation of it
  config.ts             thresholds shared by server and client
components/
  game.tsx              state, commit lifecycle, hash verification, keyboard
  instrument-panel.tsx  the flipping Hindsight / Foresight panel
  proximity-scope.tsx   the radial memory readout, shared by both faces
  telemetry.tsx         stats, read-rate sparkline, recent rounds
data/                   the persistent store (gitignored)
```

## RuVector notes

Things worth knowing, all verified against `ruvector@0.2.40` by running it
rather than inferred from the type definitions:

- **`search()` returns a distance, not a similarity.** A self-match scores
  ~1e-14. Lower is closer. Getting this backwards inverts the whole AI.
- **The backend is chosen by priority, and one option fails open.** RuVector
  tries native Rust, then RVF if `@ruvector/rvf` is installed, then a stub. The
  stub is the dangerous one: `insert()` returns fake ids and `search()` always
  returns `[]`, so the AI would look like it was learning while being
  permanently blind. `init()` rejects the stub and accepts either real backend.
  An earlier version demanded `native` specifically, which would also have
  refused RVF and failed to start on any platform without a prebuilt Rust
  binary (Apple Silicon, Alpine, ARM) where the game runs fine.
- **The database file size says nothing about how much you have played.** It is
  a [redb](https://github.com/cberner/redb) arena that pre-allocates: a store
  with *zero* episodes is already 1,589,248 bytes, and stays exactly that size
  through 200 episodes before roughly doubling at 500 and again at 1000. An
  empty file gzips to 2.8KB — 99.8% of it is padding. This is why the export is
  not the raw file.
- **There is no `clear()`, `close()` or `flush()`.** Writes persist
  automatically.
- **Deleting the .db file does not reset a running process.** The engine keeps
  process-global state keyed by storage path, so reopening the same path still
  returns every old entry. Deleting ids individually works on well-spread
  vectors but not here — these embeddings sit within ~0.003 cosine of each
  other, HNSW recall collapses, and the sweep stalls with episodes still
  indexed. **Reset therefore rotates to a new file** (`rps-memory-<ts>.db`),
  which is what RuVector's own `VectorIndex.clear()` does internally, and
  records the live filename in `data/memory-pointer.json`. Reset is
  single-flight, opens and verifies the replacement before committing the
  pointer, and only unlinks the old file afterwards, so a crash mid-reset leaves
  either the old store or the new one — never a pointer aimed at nothing.
- **Never rename the database on startup.** An earlier version folded a rotated
  generation back to `rps-memory.db` on boot to keep the filename tidy. That
  renamed the live database out from under an already-running dev server as soon
  as a second process initialised — `next build` collecting page data was enough
  to trigger it, and `/api/export` started 404ing. The pointer is now followed
  as found and no file another process might hold is ever moved. Consequence:
  after a reset the on-disk name is a generation, not `rps-memory.db`. Exports
  still download under the canonical name.
- `search()` always returns the full 384-float vector per hit; there is no
  option to suppress it. `RuVectorStore.recall()` drops it immediately.
- `ruvector` and `@ruvector/core` must stay in `serverExternalPackages`.
- The store is pinned to `globalThis` so dev hot-reload does not spawn a second
  embedder. Editing `ruvector-store.ts` needs a dev-server restart to take
  effect.

## Deploying

This runs on **Node**, not on an edge runtime. RuVector's vector database is a
native N-API addon, so it cannot run on Cloudflare Pages/Workers, Vercel Edge,
or any V8-isolate runtime — and serverless filesystems are ephemeral, which
breaks persistence regardless.

Options, in order of least change:

1. **A long-lived Node host** (Fly, Render, Railway, a VPS, a container) with a
   persistent volume mounted at `./data`. Everything works as-is.
2. **Cloudflare Containers** — full Node, so RuVector runs; needs a volume for
   `./data`.
3. **Cloudflare Pages + a separate memory service** — the Next.js frontend on
   Pages, with the round loop behind a small Node service.

If you need it on Pages directly, the swap point is `lib/memory-store.ts`.
Write one class implementing `MemoryStore` (`init` / `remember` / `recall` /
`size` / `reset` / `filePath` / `info`) against something edge-compatible — e.g.
Cloudflare Vectorize with Workers AI embeddings — and change the single
constructor call in `getStore()`. Nothing else in the app knows what RuVector
is. Note that this stops being RuVector at that point.

## Resetting and exporting

**Reset AI memory** erases every episode (two-step confirm).

**Export memory** downloads newline-delimited JSON, one episode per line, at
about 194 bytes each — **52 episodes come to 10KB**. Exporting the raw database
instead would hand over 1.6MB, roughly 99% of which is pre-allocated padding
rather than anything you played.

Vectors are deliberately omitted. They are deterministic re-embeddings of
`context`, so the metadata alone is enough to rebuild the memory — on this
engine or a different one, which is also what makes the export useful across
the `MemoryStore` seam.

The export reads `data/episodes.jsonl`, an append-only log written alongside
the database, because the vector index cannot be reliably enumerated: retrieval
at `k = len()` returns everything for well-spread vectors but collapses on real
game data. A store that predates the log gets one best-effort backfill pass on
startup, and the response reports what happened rather than quietly handing
over a short file:

```
X-Episode-Count: 52
X-Store-Size:    52
X-Export-Partial: false
```
