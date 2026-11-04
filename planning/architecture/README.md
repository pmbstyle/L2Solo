# Architecture map

Checked at 39e43408 (2026-11-04).

What exists, who owns each rule, which path is canonical. First survey: t106dev (now `ivan/next-release`) @ 9f27b7fa,
2026-11-03, six read-only passes. Line numbers drift; search by name. Read the file of the area you touch before
changing it.

## Files

Only these files are kept here; each file's first line says the commit it was last checked at.

| File | What it holds |
|---|---|
| README.md | This index: the files, how the map is kept, the category passes, the shape and the traps |
| [bot-ai.md](bot-ai.md) | Bot decisions (hot): `BotAI.tick`, `AI/States/*`, `DecisionEvents`, `Goals/*`, chat → action |
| [combat.md](combat.md) | Combat, skills, actors: `Combat/HitRules`, `Formulas`, `Actor/Attack`, `C4SkillRules`/`C4SkillEffects`, `EffectStore`; the C4 check of the combat rules |
| [economy.md](economy.md) | Economy and trade: `EconomyContext`/`WishNetwork`, `ColdEconomyPlan`, `BotAfkMarketService`, `MarketPricing`, `AfkTradeService` |
| [population.md](population.md) | Population, hot/cold, worker: `BotLifeState`, `ColdSimulation{Coordinator,Worker,Kernel,Owner}`, `HotActivation`/`Cooldown`, `BackgroundResolver` |
| [persistence.md](persistence.md) | Persistence, clans, quests, progression: `Database`, `CharacterWriteQueue`, `bot_life_state`, migrations, history DB |
| [world.md](world.md) | World, movement, runtime: `World`, `GeodataEngine`, `MoveTo`, `Automation`, `Session`, `SpotService` |
| [debt.md](debt.md) | Debt across areas and the order to pay it |
| [limits.md](limits.md) | Caps, budgets, sizes, timeouts and what happens at each |
| [tables.md](tables.md) | Precomputed bot tables: `data/Bots/spot-table.json` read by `SpotValueTable`, `data/Bots/spot-reward-npcs.json`, hunt tables `data/Bots/hunt/*` and `scripts/fight-table` (offline only), Tables workflow, when to rebuild |
| [e2e.md](e2e.md) | End-to-end scripts (`tests/e2e/*.js` played through client packets) |
| [findings.md](findings.md) | Open findings of the category passes, one row each, by category |
| check.js | Staleness check: every quoted code name in these files must still be in the code |

Measurement (CPU, lag, memory, e2e) has no map file: `scripts/perf.js`, `src/Perf/*` — `LiveRecorder` (the one
recorder, `[Perf] live`; `Threads`, `CpuProfile`, `HeapProfile`, `ChunkWorker`), window runs
`scripts/perf/{window,report,compare}.js` on a launcher save, players `HotCrowd` (hot scenario), scripted client
`PlayerClient` + `PlayerScript`; numbers come from `PopulationMetrics`/`logSummary` and
`ColdSimulationCoordinator.failureSnapshot`, the recorder adds no counter.

**How the map is kept.** Open work and current state only: a paid debt item is deleted, an area line is rewritten to
the new state; history is git (`git log -S <id>`). A change that settles an owner, removes a path, pays a debt item or
adds or changes a limit updates the touched entry in the same commit; review checks it (a change that should have
moved the map and did not is a finding). Before each release: `node planning/architecture/check.js` (lists every quoted code name that is no
longer in `src/`, `scripts/`, `tests/`, `config/`, `database/` or `launcher/main`; a name followed by "(proposed)" or
"(C4" and lines recording removed code are skipped), then a refresh scoped by `git diff <Checked at sha>..HEAD`:
update only the touched entries, delete paid items, set "Checked at" to the release head.

## Category passes

A category pass reads the whole code for one kind of fault and is refreshed every few releases (not at each release).
A pass writes its findings into [findings.md](findings.md) (verify before acting); a fixed finding's row is deleted
in the commit that fixes it. Every open row was re-checked against the code at 544a99e8 (2026-11-04).

| Category | Last run |
|---|---|
| Dead and always-taken branches | 2026-11-03, t106dev @ c29722e7 |
| Dormant features and dead config | 2026-11-03, t106dev (sha not recorded) |
| Fields written but never read / read but never written | 2026-11-03, t106dev (sha not recorded) |
| Game logic against Lisvus C4 | 2026-11-04, today's changes on top of the 2026-11-03 t106dev pass (sha not recorded) |
| One rule written as a number in several places | 2026-11-03, t106dev; re-checked at 199c3b19 (2026-11-04) |
| Silent failures and masking defaults | 2026-11-03, t106dev (sha not recorded) |
| Client entry points | 2026-11-03, t106dev (sha not recorded) |
| Purity and determinism | 2026-11-03, t106dev @ be5c09f7 |
| Races and crash/shutdown data loss | 2026-11-03, t106dev @ be5c09f7 + working tree |
| Per-step cost | 2026-11-03, t106dev @ be5c09f7 |
| Tests | 2026-11-03, t106dev; CI run 41214661352 (2026-10-31) |
| Game data against C4 | 2026-11-04, ivan/next-release @ 610abd94 |
| C4 check of the combat rules (findings are CMB rows in combat.md) | 2026-11-03, Lisvus fdc7e33, Mobius master 245bc80a |

## The shape in one screen

- **Main thread** owns World, sockets, the DB and every hot actor. **Cold worker** owns stepping of far bots and the
  economy build (wish network); it has no World and no DB, and sends proposals that main commits under a revision
  CAS (`ColdSimulationOwner`).
- **Hot bot:** `BotAI.tick` → `States[plan]`. It does not choose its job: the worker's held decision
  (`DecisionEvents.held`) does. Facts that change go back as `raiseDecision`.
- **Cold bot:** kernel step → `planLifecycle` → `BackgroundResolver` → `prepareResolve` → proposal → main commit;
  work that needs World or DB goes to main as a lifecycle command.
- **Shared by design:** `HitRules`/`Formulas`, `C4SkillRules`, `NpcHate`, `NpcCombatChoice`, `MarketPricing`/
  `PriceDecision`, `PurchaseFunding`, `TravelRoutes`, `RestPolicy`, `PartyHuntingTarget`, `DeathExperience`,
  `PkDropPolicy`.
- **Cold → hot:** `handoffToMain` (DB CAS) is the real guard; the worker fence is advisory.

## Traps

- `Cold*` in Economy is usually a main-thread service; the worker planner is `Population/ColdEconomyPlan`.
- Worker guard wraps only `invoke()`; relative `require()` and lazy invokes slip through. `SpotService` returns `[]`
  without World instead of throwing. ~40 `isMainThread` branches.
- A worker step or command that throws is held off and quarantined (`ColdSimulationKernel.fault`), a hot AI state that
  throws is held off and leaves its plan at the 5th (`BotAI` `stateFaulted`), both by `BotFaultHold` (limits.md); a
  failure a catch survives goes through `FailureLog` (counted by site, the first logged, status `swallowed=`).
- Cited but missing: `docs/architecture.md` (`BotRoute.js`, `EconomyContext.js`), `docs/t189-plan.md` (T189 commit),
  `docs/game-decisions.md` (`scripts/fight-table`, `ShotStock`).
- A precomputed table carries a fingerprint of the files it was simulated by (`TableFingerprint`): after a change listed
  in tables.md "When to rebuild", `npm run check` fails until the table is rebuilt (a table built before fingerprints:
  a warning only).
