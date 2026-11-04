# Architecture map

Checked at 199c3b19 (2026-11-04).

What exists, who owns each rule, which path is canonical. First survey: t106dev (now `ivan/next-release`) @ 9f27b7fa,
2026-11-03, six read-only passes. Line numbers drift; search by name.

Read the file of the area you touch before changing it. Debt across areas and the order to pay it: [debt.md](debt.md).
Limits: [limits.md](limits.md). C4 check: [c4-check.md](c4-check.md). Second pass by symptom (verify before acting):
`pass2-*.md` — dead branches, dormant features, fields, logic bugs, rule numbers, silent failures. Third pass:
`pass3-*.md` — client entry points, per-step cost, purity, races, tests. The pass files are dated surveys: a row is
deleted when a commit fixes it, the survey is not redone; a survey with nothing open left is deleted.

**How the map is kept.** Open work and current state only: a paid debt item is deleted, an area line is rewritten to
the new state; history is git (`git log -S <id>`). A change that settles an owner, removes a path, pays a debt item or
adds or changes a limit updates the touched entry in the same commit; review checks it (a change that should have
moved the map and did not is a finding). Before each release: `node planning/architecture/check.js` (lists every quoted code name that is no
longer in `src/`, `scripts/`, `tests/`, `config/`, `database/` or `launcher/main`; a name followed by "(proposed)" or
"(C4" and lines recording removed code are skipped), then a refresh scoped by `git diff <Checked at sha>..HEAD`:
update only the touched entries, delete paid items, set "Checked at" to the release head. Each file's first line
says the commit it was last checked at.

| Area | File | Core |
|---|---|---|
| Bot decisions (hot) | [bot-ai.md](bot-ai.md) | `BotAI.tick`, `AI/States/*`, `DecisionEvents`, `Goals/*`, chat → action |
| Population, hot/cold, worker | [population.md](population.md) | `BotLifeState`, `ColdSimulation{Coordinator,Worker,Kernel,Owner}`, `HotActivation`/`Cooldown`, `BackgroundResolver` |
| Economy and trade | [economy.md](economy.md) | `EconomyContext`/`WishNetwork`, `ColdEconomyPlan`, `BotAfkMarketService`, `MarketPricing`, `AfkTradeService` |
| Combat, skills, actors | [combat.md](combat.md) | `Combat/HitRules`, `Formulas`, `Actor/Attack`, `C4SkillRules`/`C4SkillEffects`, `EffectStore` |
| World, movement, runtime | [world.md](world.md) | `World`, `GeodataEngine`, `MoveTo`, `Automation`, `Session`, `SpotService` |
| Persistence, clans, quests, progression | [persistence.md](persistence.md) | `Database`, `CharacterWriteQueue`, `bot_life_state`, migrations, history DB |
| Bot tables (precomputed) | [tables.md](tables.md) | `data/Bots/spot-table.json` read by `SpotValueTable` (spot choice, hour value, shots, potions), `data/Bots/spot-reward-npcs.json`, hunt tables `data/Bots/hunt/*` and `scripts/fight-table` (offline only), Tables workflow, when to rebuild |
| Measurement (CPU, lag, memory, e2e) | `scripts/perf.js`, `src/Perf/*` (no map file) | `LiveRecorder` (the one recorder, `[Perf] live`; `Threads`, `CpuProfile`, `HeapProfile`, `ChunkWorker`), window runs `scripts/perf/{window,report,compare}.js` on a launcher save, players `HotCrowd` (hot scenario), scripted client `PlayerClient` + `PlayerScript` running `tests/e2e/*.js` through client packets; numbers come from `PopulationMetrics`/`logSummary` and `ColdSimulationCoordinator.failureSnapshot`, the recorder adds no counter |

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
- A worker step or command that throws is held off and quarantined (`ColdSimulationKernel.fault`, `FAULT_*` in limits.md); an `afterCommit`
  throw outside a named step is only counted (POP-2).
- Cited but missing: `docs/architecture.md` (`BotRoute.js`, `EconomyContext.js`), `docs/t189-plan.md` (T189 commit),
  `docs/game-decisions.md` (`scripts/fight-table`, `ShotStock`).
- A precomputed table is not checked against the code it measured: after a change listed in tables.md "When to
  rebuild", rebuild it (TBL-1).
