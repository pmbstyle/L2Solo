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
R2 is a priority queue, not a promise: a release takes items from the top while it has time, the rest roll over, and
items are added or removed by priority at any time.

**1. The server works (nothing dies or drops silently)**

| Item | P | S |
|---|---|---|
| Floating write promises (PvP karma `ReceivedHit` ~122, `BotManager` ~558/706/719, `RemoveShortcut`): after startup they are logged once and counted, but the write is lost and the status line does not show it; `afterCommitError` counted, never logged (details: planning/r2-investigation.md) | mid | **high** |
| One poison value stops buffered persistence for every character (`CharacterWriteQueue`, races R11) | mid | **high** |
| Governor DB queue 0 with a player online: background work starved | mid | **high** |
| Retention and WAL truncate never run during play (tables and WAL grow all session) | low | **high** |
| A party activation whose member left stays fenced: commands refused until a later cold write (races R9) | mid | mid |
| ECO-14: 591 trades refused at `TradeMeetingService.prepareTrade` because the other bot already has a meeting elsewhere; offer picking does not know it (`MeetingFare.sellerCanReach`), no cooldown, so the same offer retries every ~1.5 s. Fix: town in the meeting marker + one anchor check for picking and preparing. Plus 126 refused plans (two reserve rules; stale stack rows) | mid | mid |

**2. Performance**

| Item | P | S |
|---|---|---|
| Cold worker saturated from ~1430 bots (POP-23): the release's profiled perf run on the 1731-bot world, cut the top costs; plan several workers for 5-10k | mid | **high** |
| Static merchants and service bots (46) hot all the time: measure in that run; if notable, spawn a town's merchants when a player comes near (decided: keep hot until measured) | low | low-mid |
| Delete the actor-publication pipeline (~1000 lines, WOR-5, decided): less work on every actor move | low | mid |
| Then, as the profile confirms (pass3-step-cost): C1 cold commit writes only changed stats keys (WAL, main JSON); C2 no full `calculateStats` on every hit/regen; C3/C4 vitals and broadcast fan-out by the player index; C5 `sigma` carried in plan lines (the 350-500 ms main turns); C6 visible bot routes to the path pool | mid | **high** |
| Later perf: hot interaction queue drops, EconomyContext LRU thrash above 64 hot bots, board scan windows, wish route request cap, socket backpressure, incremental decision, sync A* on main for hot bots (WOR-2) | mid | mid |

**3. One rule, data that knows it is stale**

| Item | P | S |
|---|---|---|
| Hot revenge / mob competition / PvP defence roll with `Math.random`, cold with a seeded key (pass3-purity R1) | mid | low |
| Far bot's spot change without a trip / flight arrival never re-decides (DecisionSections ~490): decide if it is an event | mid | low |

**4. Game gaps**

| Item | P | S |
|---|---|---|
| D-S shots only via craft/board (decided): make sure bots supply them | high | low |
| Trade meetings with fighting bots (`fetchAttacks`), moving buffers (`fetchMoves`) | mid | low |
| Archer bots ignore Long Shot; pet ticket "inventory full" at 80 | mid | low |
| Soul crystal quest for bots; death-wait rule (revive chance + persona); clan warehouse reservations on | mid | low |
| PvP tails: support skill on a flagged/karma target flags the caster (CMB-21); quest monster with owner counted as a summon (CMB-22) | low | low |

## R3 — value safety (DB migrations; after the named-migration scheme is agreed with Slava)

Moved from R2 (maintainer, 2026-11-03: not a priority now):

| Item | P | S |
|---|---|---|
| `refreshInventory` merges copies with `Math.max`: any divergence becomes a duplicate; `items` must win (races R8, PER-7) | **high** | low |
| `upsertState` full-row write without revision CAS: a worker commit in between rolls back exp/level/adena (races R2) | mid | low |
| Clan money moved in separate transactions: paid twice or lost after a crash (races R12) | mid | low |
| 1-HP invented mob at spots without a template (free EXP and drops) | mid | mid |

Atomic player NPC buy and player↔bot store trades; bots on the account warehouse; social graph tables dropped.

## R4 — one rule hot and cold

Skill reuse and MP cost shared (CMB-1/2), monster damage spread (CMB-7), servitor swing through `Attack.hit`
(CMB-3), rule numbers N4-N18, companions on shared policies (AI-4), chat commands one meaning (AI-1), hot spot
fallbacks ask the worker (AI-2), disabled quests (missing item templates).

## Later — large, each with its own plan

Situational e2e scripts (planning/architecture/e2e.md: six to write, step timeouts and a "precondition failed" result) — after R2, by the maintainer's priority.

Board publication by the worker only (ECO-1), cold-bot record audit (PER-7), cold walker on its road (measure first),
one movement engine (WOR-1), schema mechanisms into one list (PER-5).
