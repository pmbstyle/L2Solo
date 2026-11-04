# Architecture debt

Checked at 39e43408 (2026-11-04).

Index across areas; details and evidence in each area file (ids: AI, POP, ECO, CMB, WOR, PER, TBL).
Add a line when you find a tail you do not fix. Delete it when it is paid (the area file states the new rule).

## Themes

1. **Failures that do not show.** The owner is `src/FailureLog.js` (a survived failure counts by site, the first
   is logged with its stack, status `swallowed=`; main and the cold worker). Left: a cold command
   request dropped as malformed is counted but still gets no ack (the worker's command waits). A rejected
   `World.fetchUser` read as "not a player" in two AI states (AI-13, perf). Every other fix is guesswork while these
   hide the cause.
2. **Hot and cold disagree on one rule.** Skill reuse (CMB-1), MP cost (CMB-2), NPC
   weapon spread (CMB-7), stat assembly (CMB-8), summon stats (CMB-10), karma wash (PER-6), spot ranking (AI-2),
   travel time (WOR-7), buyer choice (ECO-2), merchant buy (ECO-3), party admission (AI-6), transitions (POP-4).
3. **Two paths kept alive on purpose and never closed.** Parity scripts that nobody runs (ECO-9), three
   board publication paths (ECO-1), Goals over WishNetwork (AI-5), regex vs LLM commands (AI-1), two ambient engines
   (AI-9).
4. **Value moves that are not atomic.** Player NPC buy (PER-1), player ↔ bot store trades (PER-2), row CRUD in quests
   (PER-3). Risk of lost or duplicated items and adena.
5. **Rules with no owner.** Plan transitions (AI-3), "is a bot" (WOR-3), town identity (WOR-6), stat assembly (CMB-8),
   skill reuse / MP cost (CMB-1/2), cold truth `characters` vs `bot_life_state` (PER-7), a required item's bid worth
   (ECO-10: `TradeIntent.wishRows` reads the queue row, `worth` the flow's demands).
6. **Dead code.** Dormant PK-bot feature (POP-17, decided: delete), actor-publication pipeline ~1000 lines (WOR-5,
   decided: delete), social graph (PER-4, decided: delete). Small: `Global.js` `totalMemUsed` (gated on diagnostics,
   no caller); `NpcObjectIndex` scan fallback (~90 test worlds never build the index),
   `ColdCraftingService.supplementMaterials` (identity since crystals are real inputs),
   `CraftProfitPolicy.margin/inputValue/craftIncomePerHour` (tests only), `PersonaPartyPolicy.preference` reasons
   (unread), `World` `?.()` guards in `Model/Actor`, `SocialAggro`, `BotSupportPlanner`, `C4SkillEffects` (test
   doubles of an uninitialised World), write-only `lastMarketPurchase`, `lastWarehouseDeposit` (tests use them as
   evidence), party `stats.lastResolveAt` (worker patch semantics).
7. **Layering.** Combat calls bot AI and economy (CMB-12); `World.js` holds party/bot-chat logic (WOR-15);
   `Database.js` holds game rules (PER-10); town navigation (world rules) lives under `Bot/AI`.
8. **Repairs that hide bugs.** `LifecycleSafetySweep`, orphan-party reconcile, stall recovery (POP-15); start-up
   item repairs (PER-11); duck-type guard in `Npc.hit` (CMB-15).
9. **Item-skill cast tails** (beside `Backpack.castItemSkill`; client findings in [findings.md](findings.md)). Bots recall with
   their own Scroll of Escape cast in `BotTownTravel.beginEscape` (fake skill, plain `setTimeout`, scroll paid by
   TripPayment) beside `Backpack.castItemSkill` (a parallel path; `BotTownTravel.js` ~113); item casts never
   `dequeueEvent`, so a click queued during an item cast (move, attack, skill) is dropped; `Backpack.deleteItem` still
   reads `session.actor` for death, packets and gear refresh (its write goes under the bag owner); `Database.init`
   turns a throw in its callback into `utils.infoFail`, exit code 0 (NodeL2 runs its startup in a promise, so it does
   not reach this today). Bot travel paths reset the casting flag alone (`HuntingState.js` ~452, `BotTownTravel.js`
   ~109/131/139, `BotSpotTravel.js` ~43/204): a pending item cast's timer stays armed, its spent item lands on nothing,
   or lands on a newer cast; fix = those paths call `attack.abortCast`. Not C4 yet: the "already casting" gate blocks
   instant items (potions) during any cast (Lisvus `ItemSkills.castInstantly` allows them); a stunned/sleeping player
   can start an SoE (Lisvus refuses on `isAllSkillsDisabled`). Both refuse before spending, so no item is lost.
10. **Bot tables: work nobody reads** ([tables.md](tables.md), lines below). A kit surface and 9 hunt tables built on
   every rebuild, read by nothing at runtime (TBL-2, TBL-3); one rebuild run reads old inputs (TBL-4); a full copy per
   thread (TBL-7); the generator patches live owners and copies the potion stock rule (TBL-8).

12. **Readiness edge (theoretical).** `BotTargetMatchup.soloSurvival`: an attack with no MP cost and a 0 vulnerability
   modifier gives a NaN budget, which makes the envelope refuse a fight another attack wins (no 0 damage weakness in the
   data today). The fight-time bisection (25 envelope evaluations per verdict, ~0.1-0.2 ms per hot scan) can become
   one evaluation at F = 30(√(1 + (seconds − 3)/15) − 1) if it shows in a profile.

13. **`BotMarketPricing.useNpcOfferSnapshot(null)`** sets an empty price map instead of returning to main's live prices,
   so afterwards every price reads as none (only `test_first_price` ~104 passes null).

15. **Picked-tests workflow mixes geodata states in a shard.** A shard that fetched raw geodata for one file runs the
   others with it present, so `test_spawn_drop_height` (asserts the missing-geodata case) fails there while the full
   PR run (raw geodata skipped) passes it. Run raw-geodata files in their own shard.

16. **Worker restart policies.** The cold worker and the path pool slots share `WorkerRestartBackoff` (1/2/5/10/30 s,
   forever, logged); the checkpoint worker restarts every 250 ms forever, dD only (`DatabaseCheckpointCoordinator`
   ~61), the clan planning worker retries after 5 s (`ClanPlanningCoordinator` ~73). One restart rule for all.

17. **One magic flag, two C4 rules.** `Skill.fetchSpell` (Lisvus `isMagic`: cast speed, spiritshot, cast break, MP
   and land rate) also picks the damage formula (`Attack.prepareSkillDamage`, `ColdMobAction`, `BackgroundResolver`);
   C4 picks it by skill type (Mdam/Pdam handlers). So Mouth Odor Attack 4110 (MDAM, not magic) keeps `spell: true`
   ([findings.md](findings.md) D-4), and a PDAM skill flagged magic (Die! You fool!) deals magic damage.

18. **The native drop tooltip has no pages.** `NativeDropProtocol.encode` refuses more than 64 rows (8192 chars) and
   `NpcBypasses/NativeDrop` then sends the target as unavailable: Antharas 12211 (90 C4 rows since the legacy drops,
   pinned in `test_native_drop_ui`). Pages or a cut with a count, client and server together.

19. **Arrow stock tails (PR #207).** A companion's supply errand for its player (`BotSupplyErrand`, board purchase)
   meets the companion's own arrow stock at the commit guard (`checkArrowPurchaseUnsafe` checks any `bot_` buyer), so
   it cannot buy arrows for the player beyond its own room, and a non-archer none. A worker field take refused by
   the war-ticket guard at meeting accept (`war_supply_*`) still throws out of `BotAfkMarketService.executePlan`
   (only `arrow_stock_limit` is read as a deferred trade). The arrow gate on the main purchase is
   `BotLifeState.marketPurchaseBlocker`, but hot buys (`TradeService`, `AfkTradeService.buyFromShop`) reach only the
   commit guard; their refusal is the writer's error, not a counted reason.

20. **Main still builds the basics for a kit value the plan row does not publish.** `ColdShotEconomyService`
   (~155, a shot crafter's own reserve on `executePlan`'s `plan.shot`) passes `basics(state).stock('shots')` to
   `ShotCraftPolicy.recipeShotSearch`, which reads `benefitHours` (its target can disagree with the `stockTargets` shot target);
   the card view's `stock()` (`ColdEconomyDecision.view` ~464) gives `worthwhileTravel` its `benefitPerUnit`. Both
   need the stock's benefit, which `stockTargets` does not carry; publishing it (or the use rate) would move them to
   `keptKit`.
21. **A hot look reads a built sale-feasibility mask.** `HotBoardReviewService` passes the card's `feasibility`
   (`ColdOccupationSources.feasibility`, built on the build's state) to `BoardLook.feasibilityPredicate`, which keys it
   on the owner's lines only, not the reservations and item flags its bits read; a reservation made or ended since
   the build answers with the old bit until the next near decision. The cold look answers on its own state
   (`ColdOccupationSources.canSell`); on main the mask stands in for reading the reservations on every look.

21. **The supply fact misses the beginner shots.** `DecisionSections.stockIds` (~387) names the paid shot
   (`ShotStock.planForState`), while a fight loads the beginner grant first (`ShotStock.combatPlanForState`): the
   grant running out turns the shot a fight loads (`ColdCombatProfile.shotSupply`, the matchup's shot kind) with no
   supply event, so the held earning spot and a kept foundation hear it only at the next search (the window, an
   event). The source ground compares the kind itself (`sourceRouteReader`).

22. **The wish focus and dormant rows have no layout owner.** `stats.wishFocus` (`[key, sinceHours, price]`) and
   `stats.dormantWishes` rows (`[key, reason, 0, price, playedHours, loyalty]`), written by `WishNetwork` (~1038) and
   also held as `network.focus`, are read by slot in ~30 places (`focus?.[0]` in diagnostics and keys,
   `SpotEconomics.moneyShort`, `PartyIncomeComparison`, `ActorEconomyProjection`). They want one owner like
   `StatsPacket` (the money, kit and danger arrays).
23. **A buyer's wallet growing past a listed offer has no event.** `MarketBuyerWaiters` wakes a buyer only when an
   offer is listed or made cheaper (`recordChanged`); a bot whose budget grows past an offer it already saw waits
   out the failed visit's retry stamp (limits.md "Buyer retry", 15 min). A budget event re-checking the owner's
   heap nodes against the item's best offer would replace the window.
24. **A craft material party request is reviewed every 5 min.** `CraftMaterialParty.request` (`REVIEW_MS`, ~104,
   ~113) keeps the request and its worker memo for 5 min of game time instead of keying them on what the review reads
   (the material's remaining amount, the camps' forecasts, the source route reader); a time window stands in for
   those events.

23. **The forming verdict hears a member's wallet and time on the spot by its income error.**
   `PartyGoalPolicy.verdictInputs` re-judges a roster when a member's adena or `onSpotShare` moves beyond its
   `incomeError` (at least 3 %), not over an interval its answer stands on (as the earning hold's money weights):
   the comparison is not one line in them (funding delays clipped at zero, the minimum of funding and direct item
   hours, the help fee and buff price thresholds, the 10 % margins), so an interval needs the breakpoints of
   `PartyIncomeComparison.evaluate` per member. A material roster keys its wallets exactly.

24. **The earning-spot searches hear the crowd by a window.** The held earning spot (`EconomyContext` `HOLD_MS`) and
   the party comparison's own solo search (`PartyIncomeComparison.soloChoice`, same window) search again every 30 game
   minutes for the crowd, risk exclusions and spawn period at the candidate spots, which have no event
   (decision-links step 3: per-spot versions).

23. **Clan war reviews run on a window.** `ClanWarDirector.review` visits every autonomous clan each 60 s
   (`ClanWarConfig.reviewMs`, 4 per pulse) and reads its loss pressure from SQL each time, though most inputs have
   events (`ClanReviewEvents`, war accept, social relation changes, losses) or a known deadline (quiet withdrawal,
   ceasefire, loss window, intel TTL). The review is also the only sampler of enemy sightings at a spot (positions,
   no event), so it needs a sightings sampler of its own before it can wait for its events. An unchanged review is
   no longer written.

**Tests.** Gaps: nothing pins the producer side of a stock horizon (an urgent stock wish writes its `targetHours` into
`stockTargets`' `gapHorizonHours`, `EconomyContext`); `workerEconomyDecision` scenes without `nativeRoutes` have no supplied stock, so
a rich bot there has a null activity (T178): a test expecting "one leaf" from such a scene breaks the same way. Known
red in `notRunTests`: `test_beginner_shot_policy`, `test_cold_armor_set_effects`, `test_finite_market_income`,
`test_gear_intermediate_candidates`, `test_npc_purchase_consumers`, `test_task4_b5_hot_cold_same`,
`test_task4_survival_tranche` (verdicts: [findings.md](findings.md) TS6).

## Bot tables (TBL)

**P** = player impact, **S** = server impact. Evidence and the assessment: [tables.md](tables.md).

- **TBL-2 Kit surface measured, never read** (P mid, S none at runtime; CI ~60 % of the curves phase). Only
  `HuntCycle.reader` reads `SpotValueTable.kitSurface`, and nothing in `src/` calls it. So the gear a bot really wears
  never moves the table's numbers until its own hunt samples exist: a weak or a strong kit chooses spots by the author's
  kit. Decide: wire `HuntCycle` into gear and spot decisions, or drop the kit points, `HuntCycle.reader` and its tests.
- **TBL-3 Hunt tables rebuilt and committed, no runtime reader** (P none, S none; CI ~11 min, 2.4 MB churn per rebuild,
  4 tests). They also copy the catalogue, mob and henna data. Built on purpose for planned consumers (gear progression,
  the market's demand estimate; tables.md "Assessment"); the debt is the missing reader.
- **TBL-4 One `all` run reads old inputs** (P low, S none). The kit surface reads the committed `data/Bots/hunt/gear.json`; hunt
  `mobs`/`spots` read the committed `data/Bots/spot-reward-npcs.json`. After a catalogue or gear change the tables disagree until
  a second run; `npm run check` flags the hunt half (the reward catalogue is a hunt input), not the kit surface's `data/Bots/hunt/gear.json`. Order the jobs or drop the coupling (TBL-2/3).
- **TBL-5 Unread columns** (P none, S low; cheap). Row `adena`, `loot` (money is read live, `SpotRewardExpectation.value`),
  curve `adena`, spot column 4 (always 1); the generator still pools and prices loot for them (`poolRowLoot`).
- **TBL-6 Compat paths for old table shapes** (P none, S none; cheap). Loader branches for tables before `roleLines`,
  `gate`, `gateShare`, cycle columns, `mix`, `stacks` (`spot[3] * spot[4]`), and the generator's `mergeStacks`. None
  applies to the committed table: delete with their tests.
- **TBL-7 A full copy per thread, slow first read** (P low, S mid now, high at 5-10k). Main and the cold worker each
  parse 21 MB of JSON at their first lookup (~0.3 s, ~100 MB transient heap; on main a stall) and hold ~36 MB of
  Float64 arrays (values have 4 digits; 3 of 23 columns are NaN placeholders). Float32 without placeholders halves it;
  one `SharedArrayBuffer` copy or a binary pack built by the generator removes the parse and the second copy.
- **TBL-8 The generator patches live owners** (P mid, S none). In its child it replaces `SurvivalFloor.forState` (no
  unload trip: loot-heavy spots look better than live), `ShotStock.usePolicy` (always shots) and `MobExperience.rewards`
  (no level-gap penalty), and re-implements the potion stock rule in `hunt`. A change to those owners does not reach the
  table and nothing says so. Owners should take the variant as an explicit input (pure rule), the generator pass it.
- **TBL-9 Reward catalogue without a header** (P none, S low). `data/Bots/spot-reward-npcs.json` has no revision or spot count; a
  probe run's merge writes a 12-spot one to the default path (its artifact), which nobody could tell from the real one.
- **TBL-10 Small** (S low). `rankedSpotIds` re-sorts its basis on every call; the income basis scans spots down to 15
  levels below the bot while `combat` refuses anything beyond 9 (`ProgressionRates.DEEP_BLUE_LEVEL_GAP`).

## Agreed order (2026-11-03)

1. Delete the scripted PK role (POP-17); own changes: actor-publication pipeline (WOR-5), social graph (PER-4, after
   the named-migration scheme is agreed with Slava).
2. Make failures visible (theme 1).
3. Atomic value moves (PER-1, PER-2).
4. C4 check against L2J Mobius C4 (combat checked: [combat.md](combat.md) "C4 check"; open from it: support casts do not
   flag (CMB-21), owned quest NPCs count as summons in PvP memory (CMB-22)), then one function per hot/cold rule
   (theme 2).
5. Large plans, each after the perf tool: board publication (ECO-1), cold-bot record audit (PER-7), bot warehouse
   (PER-9), incremental decision, cold walker route, one movement engine (WOR-1).

Decided without the maintainer, by the rules above: one "is a bot" rule (WOR-3), one town identity (WOR-6), one
hot/cold transition (POP-4), start-up repairs removed after their cause is found (PER-11).

## Planned features

- Cold walker visible on its road (plan local to the maintainer's sessions, not in the repo yet).
- Recompute only the link a change touches: [../decision-links/plan.md](../decision-links/plan.md) (next release).
- Gear progression and the market's demand estimate from the hunt tables (current and future bots by class and level
  band: gear, hennas, consumables), see tables.md "Assessment" (TBL-3).

Each area file ends with its open questions; none blocks the order above.

## Decisions 2026-11-03, not carried out yet

- `.admin` and admin bypasses stay open to every player (solo game); README says so.
- Static "Shots:" merchants sell only no-grade shots (C4: D-S only in the GM shop 300511, Lisvus `merchant_buylists`);
  D-S come from crafting, the board or the admin panel. `staticShotsDisabled`, `FixedShotOffers` and the
  `allowsFixedShot` branches go: one rule for bots and the player.
- Disabled quests: add the missing quest-item templates (7077, 7162, 7173-7181, from the Lisvus datapack), enable
  Q035, Q038, Q039, re-check the reasons of the other 13 ([findings.md](findings.md) D4).
- Death wait: no fixed number. One function for hot, cold and `EconomicValuation`: wait while a realistic revive
  chance exists (a living party/clan member nearby with a resurrection skill and MP, or a scroll, not in combat), capped
  by a config limit (e.g. 2 min, in limits.md); without a chance, a short pause from the persona via `TendencyRoll`
  (~2-15 s). Replaces 12 s hot / 90 s cold ([findings.md](findings.md) N1).

## Found by the perf tool and e2e runs (2026-11-03)

- "Is a real player" has 8 separate predicates (`PlayerActivitySignal.isRealPlayerSession`, `BotAI`, `HotActorLodPolicy`,
  `BotTradeService`, `BotBrain`, `BotAgentTools`, `DevConsole`, `World`); part of WOR-3.
- `Request/Appeared` sends the player's UserInfo to others too.
- Adena is granted by three paths (`TradeService.giveAdena`, `AdminGiveAdena`, ...), each writing DB and backpack.
- The starter kit is written by three copies (`awardBaseGear`/`awardBaseSkills` in `BotManager`, `CreateNewChar`,
  `GeneratedColdSeeder`), each with its own two-handed and level rule.
- `HotBackgroundParty` ~328 calls `HotPartyLifecycle.confirmMarkedRaidStart`, a compatibility reader that only
  returns `Roster.nativeHotStarted`, and drops the result (a dead call).
- `BotAI.scheduleTick` catches a throw from the rest of the hot tick (outside `States[plan]`) with a bare
  `console.error("Bot AI Tick Error")` every tick, not `FailureLog` and not `BotFaultHold`: a guard before the state
  (party sync, ground loot, chat) that throws every tick is logged every tick and never held off.
- Two one-time data migrations still wait for a server without players (`activity.protected`): the persona backfill
  (`PopulationService.schedulePersonaBackfill`) and the legacy class progression migration
  (`migrateLegacyClassProgression`); with a player always online they never finish. Bring them under the governor
  (`db_maintenance`) as state retention is.
