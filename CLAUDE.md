# Working on this project

A browser-only adaptive rock-paper-scissors game. Everything runs client-side;
`next.config.ts` sets `output: "export"`, so there is no server and no API
routes. Read `README.md` first — it explains the prediction pipeline properly
and this file does not repeat it.

## Commands

```
npm run dev                      # localhost:3000
npm run build                    # static export to out/
npx tsx scripts/bench-encoder.ts # the benchmark — see below
npx eslint lib components scripts
npx tsc --noEmit                 # ignore errors under .next/, they are stale artifacts
```

There is no test suite. The benchmark is the only automated check on whether the
opponent actually plays well, which makes the discipline around it load-bearing.

## The benchmark rule

`scripts/bench-encoder.ts` prints **two** tables. They are not interchangeable.

- **FAMILIAR** — opponents the predictor has been developed against. Useful for
  iterating. Worthless as evidence, because anything tuned against it will look
  good on it.
- **HELD OUT** — opponents written to be unlike any mechanism in the predictor.
  This is the one that decides whether a change ships.

**Rules, in order of how easy they are to rationalise away:**

1. **Do not tune constants against the held-out set.** Freeze them, then
   measure. If you find yourself adjusting a threshold because a held-out row
   looks bad, you have converted it into a familiar one and it is spent.
2. **Do not add an opponent in the same change that needs it.** If the existing
   bench cannot demonstrate an idea's value, that is a finding about the idea,
   not a gap in the bench.
3. **An opponent must not be a restatement of a mechanism in the predictor.**
   Five experts scored against opponents that replay those five experts is a
   matched filter — it can only confirm.
4. **A change ships only if it clears the held-out table.** However good the
   argument is.

These are written down because all four were broken at once. See "Benchmarking
honestly" in the README — an expert-committee change measured as a net loss,
was rescued by a co-designed opponent and four fitted constants into a
convincing +0.7pp, and then came out at −0.5pp mean / −2.7pp worst case against
opponents nobody had designed it against. It was reverted. The opponent that
caught it (`Markov on own last throw`) is a player whose bias is in the
*transitions* rather than the marginal — every safeguard in that change
inspected move frequencies, so it walked past all of them.

## Settled decisions

**No vector database.** `ruvector` was used originally and removed deliberately
(commit `2de206b`) — it needed a Node server, a native addon, and an 86MB ONNX
model, and the transformer was *worse* at the discrimination k-NN needs (0.9934
cosine between one-move-different contexts, against 0.6978 for the hand-written
encoder). Re-checked against shipped package files in July 2026: `ruvector`
still cannot run in a browser and its "wasm" fallback is a stub whose `search()`
returns `[]` while reporting success. `@ruvector/rvlite` does work in-browser
but costs 239KB brotli to replace a brute-force scan that is already faster at
this scale. Exact cosine over 5000×57 is sub-millisecond; ANN solves a problem
this project does not have until roughly a million episodes. Do not re-litigate
without a server and a shared corpus, which is a different product.

**Confidence carries no absolute-distance term**, deliberately. These vectors
sit within ~0.001–0.09 cosine of each other, so `1 - d/reference` stays pinned
near 1.0 and measures nothing. See `lib/predict.ts`.

## Things that have bitten

- **`store.size()` is not a sequence number.** They agree only until the
  5000-episode retention cap, after which size freezes while `seq` keeps
  climbing. Substituting one for the other silently disabled recency decay for
  any player past the cap. `MemoryStore` exposes both; the names are worth
  respecting.
- **The bench passes the true `seq` and never reaches the cap**, so it cannot
  catch that class of bug. Store-level invariants need checking by hand.
- **Stale `.next/dev/types` files** produce `tsc` errors referencing deleted API
  routes. `rm -rf .next/dev/types` — not a real failure.

## Deployment

Not discoverable from the repo: there is no deploy config committed anywhere.
`rps.shaal.dev` is an existing **Cloudflare Pages** project named `rps-ai`,
production branch `main`.

```
npm run build
npx wrangler pages deploy out --project-name=rps-ai --branch=main
```

Auth comes from an existing token in `~/.wrangler/config/default.toml`;
`wrangler` is not installed globally, so use `npx`. Do not pass `--commit-hash`
(it emits a spurious git error). The custom domain can lag the deployment URL by
~15s, so wait before verifying or you will see the previous build.

Because this is manual, **production drifts behind `main`**. A push-triggered
Action would fix it.

## Writing changes

Commit messages here are long, specific, and lead with the measurement. Look at
`git log` before writing one. They explain *why* a change is correct and what
was measured, quote real numbers, and record what was tried and rejected —
including approaches that did not work. A commit that just says what changed is
below the bar for this repo.

Every number in the README is reproducible from the bench. If you change
behaviour, re-run it and update the tables rather than leaving them stale.
