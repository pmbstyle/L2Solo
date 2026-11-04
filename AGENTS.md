# L2Solo — rules for coding agents

Lineage II Chronicle 4 server emulator (a NodeL2 fork) for a solo MMO: the world is populated by bots, simulated
"hot" near the player (main thread) and "cold" elsewhere (a worker thread). Node.js >= 22.5, CommonJS, SQLite, no
build step. These rules apply to every agent and every change, whoever wrote the code being changed.

The map of what exists, who owns each rule and which path is canonical: `planning/architecture/` (start with
`README.md`; read the area you touch before changing it).
`planning/` holds open work only: a finished plan, audit or report is deleted in the commit that finishes it
(what was done lives in the commits and the code).
`planning/architecture/` keeps only README.md, bot-ai.md, combat.md, economy.md, population.md, persistence.md, world.md,
debt.md, limits.md, tables.md, e2e.md, findings.md and check.js; no other md under `planning/` is committed except an
open plan for a large item, deleted when it is done.

## Performance is a primary criterion

The server targets ~1700 bots today on modest hardware; the goal is 5-10k. Every decision weighs CPU, memory and DB writes as
much as behaviour:
- A change states its cost: what it adds or removes per bot per step (computations, allocations, DB writes,
  messages to the worker), and on the main thread vs the worker.
- Prefer the cheaper of two correct rules; reuse a computed result instead of recomputing; no work on the main thread
  that the worker can do; no per-tick scans over all bots.
- Development is a balance between simulation, realism and performance. Say which one a choice trades.
- A player can be online all the time. No work waits for an idle server (no player): maintenance, cleanup and
  repairs run with a player online within a stated stall budget; only what cannot (e.g. VACUUM) runs at boot or
  shutdown.
- Keep game rules pure functions of plain data (no World or DB inside a rule), deterministic (seeded rolls), owned
  once, crossing the worker boundary as explicit plain messages. Do not grow per-bot state or per-step work without
  need: it multiplies with the population.

## Architecture debt: do not add to it

The codebase was written by AI agents; core mechanisms were rewritten many times, mostly patched where a symptom
showed, so there are parallel paths for the same rule, leftover old paths and half-done unifications. The direction
is one mechanism per rule.

- The current code is not the spec: it has bugs, and existing behaviour and tests may encode one. When two paths
  disagree, the answer is what C4 does (or the stated design), not whichever path exists; say which and why. A test
  that pins a wrong behaviour is fixed with the code.
- Before a fix, find who owns the rule (the mechanism that decides it, not the spot where the symptom shows) and fix
  it there. If several paths compete, say so and ask which one stays before writing code.
- No local patches: no special case, guard or retry at the call site to hide a wrong result from the owner.
- No new parallel mechanism. Before writing a helper, cache, planner or rule, search for an existing one (by the
  concept, not by the name) and reuse or extend it.
- When a new path replaces an old one, the old one is removed in the same change, with its tests and config keys.
- Hot and cold share the rule (one function both call), not two copies.
- Tails found but not fixed (duplicate path, dead code, half-migration): add a line to
  `planning/architecture/debt.md`; do not fix them inside an unrelated change.
- The map holds the current state and open work only: a paid debt item is deleted, an area line is rewritten to the
  new state. When a change settles a canonical path, removes a path, pays a debt item or changes a limit, update
  `planning/architecture/` in the same commit; a review treats a missing map update as a finding.
- Code merged from another branch that breaks these rules is rewritten to them in its own commit that says what it
  brings in line and why.

## Code

- `require('../src/Global')` sets globals: `invoke('GameServer/...')` loads a module from `src/`, also `utils`,
  `options`, `path`. Use them as neighbouring code does.
- 4-space indent, `'use strict'`, ESLint `eslint:recommended`. Match the density and style of the surrounding code.
- Comments explain the game rule or the reason, not the code. No blanket JSDoc: a module that owns a rule gets a short
  header (what it owns and who calls it: hot, cold, worker); document data shapes only at boundaries that are easy
  to get wrong (worker <-> main messages, the `bot_life_state` row, `ColdEconomyPlan` plans).
- Game behaviour follows C4. References: the C4 sources L2J Lisvus and L2J Mobius C4 (rules and formulas) and
  https://l2hub.info/ (C4 game data). When they disagree, say so and which one is used. When behaviour is our choice,
  not C4, say so.
- The cold worker has no `World`: worker code must not reach World-dependent services; pass the lookup in.
- Data under `data/` produced by a `scripts/generate-*` script: change the generator and regenerate, never edit the
  JSON by hand. After changing items, mobs, skills or spawns, run `npm run generate:knowledge-base`.
- Bot tables (`data/Bots/spot-table.json`, `spot-reward-npcs.json`, `hunt/*`) are simulated by real code and carry a
  fingerprint of their input files. A change to a path in `planning/architecture/tables.md` "When to rebuild" makes
  them stale: `npm run check` warns locally and fails on CI; rebuild them before the PR.
- Limits (caps, budgets, page/byte sizes, pool sizes, timeouts) live in `planning/architecture/limits.md`; a new or
  changed limit gets a row, and hitting it must be observable (a counted reason, not a silent drop).
- A survived failure is never silent: count it through `src/FailureLog.js` (site + first stack), never rethrow from a
  timer.
- Secrets and machine paths go only in `config/local.ini` (gitignored).

## Tests

- Every `tests/test_*.js` is listed in `scripts/run-tests.js` (`tests`, `geodataTests`, or `notRunTests` with a
  reason), otherwise the runner fails.
- Tests pin behaviour a player or the world can observe, not internals (which module was called, a cache key, a
  private field, log wording). There are ~1200 already: extend an existing behaviour test; add one only for a
  behaviour nothing pins. A test of internals that a refactor breaks, while the behaviour is pinned elsewhere, is
  deleted.
- Plain `node:assert/strict` scripts, no framework; look in `tests/helpers/` before writing a fixture.
- One test: `node --require ./tests/helpers/databaseIsolation.js tests/test_x.js`. A change to `config/default.ini`
  or `launcher/` also runs `cd launcher && npm test`.

## Workflow

- Dead code: prove by search that nothing reaches it (`invoke`, `require`, method names, tests, scripts) before
  deleting; batch such deletions.
- A behaviour change is reviewed on its diff before commit, by a review agent (Claude `/code-review`, Codex review),
  not by hand.
- A commit is the work on one problem (one bug, gap or rework) with its tests and map update, not one per edit; it
  builds and passes its own tests. Two problems are two commits.

## Commits and PRs

- Commit subject in the imperative, capitalized, no prefix, no period, ~50-72 chars ("Prevent bot inventory overload
  and clean surplus stock"). Body optional: one short plain paragraph, the cause then the fix. No AI co-author or
  session lines.
- PR description: plain, simple English. Lead with the bugs fixed (what was broken in the game, what works now);
  internal reworks in one line; performance gains with numbers when measured.
