# Bot decision-making (hot)

Checked at 199c3b19 (2026-11-04).

Survey of t106dev @ 9f27b7fa (2026-11-03). Line numbers drift (~); search by name.
Scope: `Bot/AI`, `Bot/Goals`, `Bot/BotAI.js`, chat → action. Cold stepping: [population.md](population.md).

## Mechanisms

| Mechanism | Decides | Entry |
|---|---|---|
| `BotAI.tick` | Order of guards per hot tick: PvP defense, board meeting, clan-alliance AI, trade, buff duty, LOD gate, chat arrival, auto-buy, far-away gate, death, loot, clan hall, hot competition, hot bot-party, then `States[session.plan]` | `BotAI.scheduleTick` via `HotAiDispatcher` |
| `AI/States/*` | What the body does: hunting, following, resting, shopping, getting_buffed, fleeing, pk_* | `state.tick(...)` from `BotAI.tick` |
| Activity / occupation | Which job (hunting, selling, shopping, crafting, improving). **Decided by the worker**; a hot body only reads it | `DecisionEvents.held(session).network.activity` |
| Re-decision | When the held decision is stale | `DecisionEvents.raiseDecision(session, reason)`; near raise goes to the worker. Whether a far bot hears it now: `Economy/Reaction.js` (T189: only at its player's moment; our rule) |
| Solo spot step | Go to a spot or search locally | `BotDecisionService.suggest` (from HuntingState only) |
| Hot target | Which mob | `BotTargetScorer`, `BotHuntingTargetPolicy`, `BotHuntingGroundPolicy`; solo: ready fights first (`HuntingState.readyRanked`), line of sight in bounded batches that resume where a blocked one stopped, over every candidate before the scan gives up (`BotHuntingVisibility.batch` / `select`, limits.md); party: `Population/PartyHuntingTarget` (hot and cold) |
| Rest | Sit or not | `AI/RestPolicy` (hot, cold, BotStatus) |
| Far-solo goals | Persisted market goals of cold bots | `Goals/NeedsEvaluator` → `GoalPlanner` → `GoalState` → `GoalExecutor` (`GoalService.review`, null when hot) |
| Hot bot-only party | Leader, spot return, buffs, raid prep | `AI/HotBackgroundParty` |
| Player's companions | Follow, assist, heal, buff, rest | `States/FollowingState` + `PartyCompanionService` |
| Party admission | Whether a bot joins the player | `AI/BotAvailability.evaluate` (session) / `evaluateState` (cold) |
| Player chat → action | LLM on: `BotDialogueArbiter` → `BotBrain` → `BotAgentTools`. LLM off (default): regex `BotManager.applyPlayerSpeechRules` | `BotManager.handlePlayerSpeak` |
| Ambient chat | Bot scenes and chatter, under `BotChatterBudget` | `BotManager.checkAndStartConversation` (`BotAmbientDirector`) |

Rule stated in code (`BotAI.js` ~497, enforced by `ALLOWED_EVENTS` in `BotBrain.js` ~21): autonomous state changes belong to the
deterministic brain; the LLM acts only on explicit player communication.

## Canonical owners

| Rule | Owner |
|---|---|
| Activity choice, hot and cold | Worker economy build (`WishNetwork` leaf, `ColdEconomyDecision`); hot reads `DecisionEvents.held` — "the body's target search cannot invent a new job" |
| When to re-decide | `DecisionEvents.raiseDecision` + `Reaction.js` (where a far bot stands) |
| Solo hunting spot | Worker leaf `spotId`: `Population/BotRoute.choose`/`leafChoice` over `LevelingRoutes.scoreSpot`/`bestSpot` with `SpotEconomics` income (decided, AI-2); values from the spot table, [tables.md](tables.md) |
| Party target | `Population/PartyHuntingTarget` |
| Rest thresholds | `AI/RestPolicy` |
| Solo fight admission: start the next mob, and the route's solo gate (the same rule at full HP and MP) | `AI/BotEncounterReadiness` (hot `HuntingState`, cold `BackgroundResolver.resolveFight`, route `BotTargetMatchup.soloCanHunt`): the fight must end above the potion line (`HealingPotionStock.useThreshold`), with a margin that grows with its length; attacks count only the MP above `BotClassPolicy.offensiveMpReserve` |
| Empty ground: a solo hunter's spot whose spawn groups admit none of its fights (`BotTargetMatchup.spotShares` / `admitsNone`, the gate above at the whole bar) | One rule hot and cold, raised as `unhuntable` (Reaction: occupation + sources, heard everywhere): raised only when the route's view (`readyProfiles`: pet raised, MP whole) refuses too, once per stay (`stats.emptyGround`, written by both sides, cleared by prey). Cold `BackgroundResolver.resolveSolo` (no walk, no pick; `debug.unhuntable`) → `BotLifeState.prepareResolve` → `DecisionSections.events` (ends the hunt window: `event`); hot `BotDecisionService.suggest` after `EMPTY_HUNT_SCANS`, one look per empty streak (`raiseDecision`). The rebuild searches the spot afresh and drops the kept route. A bot short only of what the route counts whole gets ready instead (C4: a summoner raises its pet before it engages): cold `BackgroundResolver.getReady` casts the pet out of the fight (`ensureColdSummon`), heals a living pet, or sits only when the rest changes what the gate reads (the summon's MP or reuse, a pet that only regenerates), else raises; hot `BotDecisionService.readyLook` → `SummonerTactics.raisePet` / sit / wait on a summon's or pet heal's reuse, one look per streak, a second summon or wait on the stay that changed nothing raises (`session.groundReadying`); its ready view from the live body (`actorReadyProfiles`) |
| Party heal line | `AI/PartyHealPolicy` (`HEAL_BELOW`, `score`): cold `BackgroundResolver`, hot `BotPvpTactics.support` |
| Party admission | `AI/BotAvailability` |
| Player command meaning | `BotAgentTools` (decided, AI-1; the regex path, labelled legacy, still has its own meaning) |
| Plan transition (`session.plan = …`) | **none** (AI-3) |
| Seeded rolls | `AI/TendencyRoll` (own FNV loop + mulberry mix; does not call `Bot/Fnv1a`, see AI-11) |

## Debt

- **AI-1 parallel path: player commands, regex vs LLM tools mean different things.** Regex is the default
  (OpenRouter off). "stop": regex → `plan='resting'`; tool `stay_here` → `botStay` and keeps the plan. "hunt" for a
  companion: regex detaches from the party, tool keeps it. "follow": regex raw `moveTo`, likely undone by the next
  hunting tick; tool uses `ChatArrivalState`. `BotManager.applyPlayerSpeechRules` ~1119-1213. **Decided 2026-11-03:**
  regex only maps words (whole words, not substrings) to an intent and calls the same `BotAgentTools` action the LLM
  calls. Meaning = the tool's: "stop" = `stay_here` (stand, keep the plan), "hunt" = hunt and stay in the party,
  "follow" = `ChatArrivalState`.
- **AI-2 parallel path: two spot rankers.** Hot `SpotService.findBestSpot` (own density score +
  `LevelingRoutes.scoreSpot`, no `SpotEconomics` income) vs cold `BotRoute.choose` (`LevelingRoutes.rankedSpots` is
  only the seeder's, `GeneratedColdSeeder`). Hot fallbacks bypass the worker leaf: `BotDecisionService` (recovery,
  after town), `HuntingState` (unsafe ground), `ClanHall/Departure.js`; all four `findBestSpot` calls are live. A hot
  bot can pick ground the worker would not. **Decided 2026-11-03:** hot fallbacks raise the fact (`raiseDecision`)
  and wait for the worker's spot; an unsafe spot is left first (existing escape), then the bot waits.
  `SpotService.findBestSpot` goes.
- **AI-3 no owner of plan transitions.** ~70 `.plan =` sites in ~21 modules; side effects (abort automation,
  clear target, stand/sit, raise decision) repeated at each. `ArenaDuelService` sets `'arena'`, which has no state.
- **AI-4 FollowingState own thresholds.** Rest 0.30/0.15 vs `RestPolicy.party` 0.30/0.18; heal 0.70 hardcoded
  instead of `PartyHealPolicy`; more local lines 0.65…0.25; own `selectHeal` beside `BotSupportPlanner`. **Decided
  2026-11-03:** companions use `RestPolicy`, `PartyHealPolicy`, `BotSupportPlanner`; a real difference for a party with
  a player becomes a parameter of the shared policy.
- **AI-5 (technical, no product decision; plan it with ECO-1):** half-migration: Goals over WishNetwork. `NeedsEvaluator` says there is no priority ladder, yet emits
  priorities 100/96/80/50 sorted by `GoalPlanner`. `GoalState` keeps a second copy of the decision in the DB. Hot
  executes the leaf inline in HuntingState, cold through `GoalExecutor`.
- **AI-6 hot/cold copy in `BotAvailability`.** `evaluate` vs `evaluateState`: same chain, different "already grouped" tests.
- **AI-7 two "near a player" gates in `BotAI.tick`** (LOD 'preload' and `visibleRealPlayers`), both fire far-away chat;
  two copies of `visibleRealPlayers` (BotAI, itself with three fallback paths; BotBrain with its own `visibilityRadius`).
- **AI-8 dead code.** `DecisionEvents` reasons build/supply/occupation/combat/benefits are accepted but never passed
  to `raiseDecision` (they are section names `raiseSections` uses); `BotDecisionService.suggest` branches for
  dead/resting/following likely unreachable; `MerchantState` empty.
- **AI-9 two ambient engines.** `BotAmbientDirector` (default, `ambientScenesEnabled`) and legacy `BotConversation` path;
  `checkAndStartConversation` asks `BotConversation.canStart` even when the director runs.
- **AI-10 silent catches.** `BotAI.js` around modules that always exist; `FollowingState` test guard in production;
  empty catches: BotBrain ~13, PartyCompanionService 7, ShoppingState 5; `HuntingState` uses a rejected
  `World.fetchUser` as control flow; a throwing state is logged and repeats every tick.
- **AI-11 ~12 copies of the FNV hash** beside `Bot/Fnv1a.js` (incl. `TendencyRoll`, `SpotService`, `LevelingRoutes`,
  `PartyHuntingTarget`, `ColdOccupationSources`). Matters if hot and cold rolls must agree.
- **AI-12 two sell-trip checks in HuntingState** (leaf 'selling' and unconditional), each starts shopping.

## Open questions

1. AI-1: regex commands — decided 2026-11-03: delegate to `BotAgentTools`.
2. AI-2: hot spot fallbacks — decided 2026-11-03: raise and wait for the worker.
3. AI-4: companion thresholds — decided 2026-11-03: read the shared policies.
4. AI-5: is `GoalState` persistence still needed, or should Goals shrink into a view over the card?
5. Hot bot-party heal during PvE — answered: `BotPvpTactics.support` (scored by `PartyHealPolicy.score`),
   called by `HotBackgroundParty` ~494 (between fights) and ~531 (each hunt step).
