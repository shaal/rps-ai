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

## How the AI actually plays

Each round runs one `POST /api/round`, and the server:

1. **Builds a context string** from the history *ending before* your current
   move — embedding a context that included the move being predicted would leak
   the answer.
2. **Embeds it** with `OnnxEmbedder`.
3. **Searches** the vector store for the `k=12` nearest past situations.
4. **Aggregates** what you played next in those situations, weighting each
   memory by three independent signals (below).
5. **Samples** a predicted move from that distribution and plays the counter.
6. **Records** the episode — context, what you actually played, the AI's move,
   the outcome, and a monotonic sequence number.

The first 5 rounds are thrown blind so there is something to bootstrap from.

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

### Difficulty

Difficulty maps to a sampling temperature *and* an exploration rate, not one
knob. Below a confidence of 0.35 the temperature is inflated further — that is
the "don't play a weak read like a strong one" valve.

| | temperature | random throws |
|---|---|---|
| Casual | 1.8 | 35% |
| Rival | 0.9 | 10% |
| Ruthless | 0.35 | 5% |

The AI samples rather than always countering its top read. Pure argmax is
detectable within about ten rounds and invites counter-countering.

## Measured behaviour

Against a scripted player, difficulty `ruthless` unless noted:

| Scenario | Result |
|---|---|
| Predictable `R>P>S` cycle, 90 rounds | read rate **87% → 100%** (chance is 33%), AI won 74/90 |
| Strategy switch mid-game | 100% → **27%** immediately after the switch → 88% → **100%** |
| Genuinely random player | read rate **30%** ≈ chance, human 26 / AI 23 |
| Casual vs Rival vs Ruthless, 60 rounds | human won **18**, **17**, **3** |

The strategy-switch row is the interesting one: recency decay means it goes
blind when you change tactics, then re-learns you.

The random-player row matters too — it does not manufacture false competence
against play that genuinely has no pattern.

## Layout

```
app/
  page.tsx              server shell, kicks off model warmup
  api/round/route.ts    play a round: predict → resolve → record
  api/status/route.ts   warmup state, memory size, engine info
  api/reset/route.ts    erase all memory
  api/export/route.ts   download the .db file
lib/
  rps.ts                pure game logic + the context builder
  predict.ts            pure weighting, confidence, sampling
  engine.ts             singleton store, one round of the adaptive loop
  memory-store.ts       the storage interface  ← swap point
  ruvector-store.ts     RuVector implementation of it
  config.ts             thresholds shared by server and client
components/
  game.tsx              state, throws, keyboard, confetti
  proximity-scope.tsx   the radial memory readout
  memory-panel.tsx      context, prediction, strongest memories
  telemetry.tsx         stats, read-rate sparkline, recent rounds
data/                   the persistent store (gitignored)
```

## RuVector notes

Things worth knowing, all verified against `ruvector@0.2.40` by running it
rather than inferred from the type definitions:

- **`search()` returns a distance, not a similarity.** A self-match scores
  ~1e-14. Lower is closer. Getting this backwards inverts the whole AI.
- **The native addon fails open.** If the platform binding does not load,
  RuVector silently substitutes a no-op stub where `insert()` returns fake ids
  and `search()` always returns `[]` — the AI would look like it was learning
  while being permanently blind. `RuVectorStore.init()` refuses to start unless
  `getImplementationType() === "native"`.
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

**Reset AI memory** erases every episode (two-step confirm). **Export memory**
downloads the raw `.db`. Both are in the header.
