# Roadmap: small releases every few days

**Open work only.** A finished item leaves this file; what was done lives in the commits (and in the release's PR
description). Keep it current: when an item is committed, delete its row.

Each release: finish its changes → stop → full CI on the fork → Claude tests the world (perf.js before/after +
behaviour checks in logs/DB, `planning/perf-tooling/test-recipe.md`) → fix what broke → PR to `origin/develop`
(description for Slava, plain English, bugs first). No new work starts while a release is being tested.

**Sorting.** **P** = player impact, **S** = server impact (CPU, memory, DB writes, stability). Performance counts as
much as behaviour (CLAUDE.md). High S + high P first; a cheap high-S item goes early even if P is low.

## R1 — released (PR #208, 2026-11-04)

## R2 — the server works, then speed

R2 part 1 released (PR #209/#210, 2026-11-04): allStates cap, path pool restarts, 32-64 KB packets, NPC chase give-up, failures that show (`swallowed=`).

Priority (maintainer, 2026-11-03): the server works → performance → one rule → game gaps. Value safety and tooling wait.
Who: the maintainer working on the item (ivan / slava); empty = free. Put your name and push before you start;
do not take an item someone else holds; delete the row with the commit that finishes it.
R2 is a priority queue, not a promise: a release takes items from the top while it has time, the rest roll over, and
items are added or removed by priority at any time.

**1. The server works (nothing dies or drops silently)**

| Item | P | S | Who |
|---|---|---|---|
| Fence without an owner (races R6): a release by id can drop another owner's fence; owner tokens | mid | mid |  |
| Retention and WAL truncate never run during play: state retention deferred 29× 'player_protected' in a 15-min hot run, WAL 387+ MB (tables and WAL grow all session); run them through the governor, measure the truncate stall; count the truncate gate's refusals (silent today) | low | **high** | ivan |

**2. Performance**

| Item | P | S | Who |
|---|---|---|---|
| Cold worker headroom (POP-23): ~40 % at 1731 bots after R1; profile its top costs and plan several workers for 5-10k | mid | mid |  |
| Static merchants and service bots (46) hot all the time: measure in that run; if notable, spawn a town's merchants when a player comes near (decided: keep hot until measured) | low | low-mid |  |
| Delete the actor-publication pipeline (~1000 lines, WOR-5, decided): less work on every actor move | low | mid |  |
| Then, as the profile confirms (pass3-step-cost): C1 cold commit writes only changed stats keys (measured: `bot-life:save` rewrites the whole ~19 KB row, ~72 KB of WAL per save, ~4 MB/s in warm-up) (WAL, main JSON); C2 no full `calculateStats` on every hit/regen; C3/C4 vitals and broadcast fan-out by the player index; C5 `sigma` carried in plan lines (the 350-500 ms main turns); C6 visible bot routes to the path pool | mid | **high** |  |
| Later perf: hot interaction queue drops, EconomyContext LRU thrash above 64 hot bots, board scan windows, wish route request cap, socket backpressure, incremental decision, sync A* on main for hot bots (WOR-2) | mid | mid |  |

**3. One rule, data that knows it is stale**

| Item | P | S | Who |
|---|---|---|---|
| Hot revenge / mob competition / PvP defence roll with `Math.random`, cold with a seeded key (pass3-purity R1) | mid | low |  |
| Far bot's spot change without a trip / flight arrival never re-decides (DecisionSections ~490): decide if it is an event | mid | low |  |

**4. Game gaps**

| Item | P | S | Who |
|---|---|---|---|
| Stackable flag flipped on 222 items, mostly quest items (pass4 D-5); check save rows merge | mid | low |  |
| Deep-blue adena at x10/x50 about rate× too rare: `ProgressionRates` ~214 divides the adena rate by the drop rate, a Lisvus step of the seeded/spoil path only (L2Attackable ~966); categorized adena has no divide (~1096-1118). Also cold takes the killer's level for the gap, hot the highest attacker's | mid | low |  |
| Spot comfort: a player farms where one bar lasts many kills; a spot where he sits after nearly every kill he leaves (or seeks a party). Spot value per hour already pays for rest time (`kph` from simulated hours), but nothing scores kills per bar: one long rest and a sit per kill cost the same hour (`SpotValueTable`/`LevelingRoutes.scoreSpot`, gate `BotTargetMatchup.pullVerdict` judges one pull) | mid | low |  |
| D-S shots only via craft/board (decided): make sure bots supply them | high | low |  |
| Trade meetings with fighting bots (`fetchAttacks`), moving buffers (`fetchMoves`) | mid | low |  |
| Archer bots ignore Long Shot; pet ticket "inventory full" at 80 | mid | low |  |
| Soul crystal quest for bots; death-wait rule (revive chance + persona); clan warehouse reservations on | mid | low |  |
| PvP tails: support skill on a flagged/karma target flags the caster (CMB-21); quest monster with owner counted as a summon (CMB-22) | low | low |  |

## R3 — value safety (DB migrations; after the named-migration scheme is agreed with Slava)

Moved from R2 (maintainer, 2026-11-03: not a priority now):

| Item | P | S | Who |
|---|---|---|---|
| `refreshInventory` merges copies with `Math.max`: any divergence becomes a duplicate; `items` must win (races R8, PER-7) | **high** | low |  |
| `upsertState` full-row write without revision CAS: a worker commit in between rolls back exp/level/adena (races R2) | mid | low |  |
| Clan money moved in separate transactions: paid twice or lost after a crash (races R12) | mid | low |  |
| 1-HP invented mob at spots without a template (free EXP and drops) | mid | mid |  |

Atomic player NPC buy and player↔bot store trades; bots on the account warehouse; social graph tables dropped.

## R4 — one rule hot and cold

Skill reuse and MP cost shared (CMB-1/2), monster damage spread (CMB-7), servitor swing through `Attack.hit`
(CMB-3), rule numbers N4-N18, companions on shared policies (AI-4), chat commands one meaning (AI-1), hot spot
fallbacks ask the worker (AI-2), disabled quests (missing item templates).

## Later — large, each with its own plan

Situational e2e scripts (planning/architecture/e2e.md: six to write, step timeouts and a "precondition failed" result) — after R2, by the maintainer's priority.

Board publication by the worker only (ECO-1), cold-bot record audit (PER-7), cold walker on its road (measure first),
one movement engine (WOR-1), schema mechanisms into one list (PER-5).
