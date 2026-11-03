# Architecture debt

Checked at 516f6ef9 (2026-11-03).

Index across areas; details and evidence in each area file (ids: AI, POP, ECO, CMB, WOR, PER).
Add a line when you find a tail you do not fix. Remove it when it is paid.

## Themes

1. **Failures that do not show.** (Paid: worker throws held off and quarantined, POP-1, 6e521123; process
   backstop for unhandled rejections and uncaught exceptions, 39f8d4fe.) Left: `afterCommit` errors outside a named
   step only counted (POP-2), `catch → null` routes (POP-3), economy catches (ECO-11), AI empty catches (AI-10), stat recalculation (CMB-14),
   geometry parse (WOR-13). Every other fix is guesswork while these hide the cause.
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
6. **Dead code.** Dormant PK-bot feature (POP-17), actor-publication pipeline ~1000 lines (WOR-5, decided: delete),
   social graph (PER-4, decided: delete). Small items paid 2026-11-03. Left: `Global.js` `totalMemUsed` (gated on
   diagnostics, no caller; found by perf-tooling). Left from the pass-2 cleanup: `NpcObjectIndex` scan fallback (~90
   test worlds never build the index), `ColdCraftingService.supplementMaterials` (identity since crystals are real
   inputs), `CraftProfitPolicy.margin/inputValue/craftIncomePerHour` (tests only once `publishDemand` went),
   `PersonaPartyPolicy.preference` reasons (unread), `World` `?.()` guards in `Model/Actor`, `SocialAggro`,
   `BotSupportPlanner`, `C4SkillEffects` (test doubles of an uninitialised World), write-only `lastMarketPurchase`,
   `lastWarehouseDeposit` (tests use them as evidence), party `stats.lastResolveAt` (worker patch semantics).

7. **Layering.** Combat calls bot AI and economy (CMB-12); `World.js` holds party/bot-chat logic (WOR-15);
   `Database.js` holds game rules (PER-10); town navigation (world rules) lives under `Bot/AI`.
8. **Repairs that hide bugs.** `LifecycleSafetySweep`, orphan-party reconcile, stall recovery (POP-15); start-up
   item repairs (PER-11); duck-type guard in `Npc.hit` (CMB-15).
9. **Item-skill cast tails** (left by the X5 fix 39f8d4fe, [pass3-client.md](pass3-client.md)). Bots recall with their own
   Scroll of Escape cast in `BotTownTravel.beginEscape` (fake skill, plain `setTimeout`, scroll paid by TripPayment)
   beside `Backpack.castItemSkill` (a parallel path; `BotTownTravel.js` ~113); item casts never `dequeueEvent`, so a
   click queued during an item cast (move, attack, skill) is dropped; `Backpack.deleteItem` still reads `session.actor`
   for death, packets and gear refresh (its write goes under the bag owner); `Database.init` turns a throw in its
   callback into `utils.infoFail`, exit code 0 (NodeL2 now runs its startup in a promise, so this no longer hits it).
   Bot travel paths reset the casting flag alone (`HuntingState.js` ~452, `BotTownTravel.js` ~109/131/139,
   `BotSpotTravel.js` ~43/204): a pending item cast's timer stays armed, its spent item lands on nothing, or lands on a
   newer cast; fix = those paths call `attack.abortCast`. Not C4 yet: the "already casting" gate blocks instant items
   (potions) during any cast (Lisvus `ItemSkills.castInstantly` allows them); a stunned/sleeping player can start an SoE
   (Lisvus refuses on `isAllSkillsDisabled`). Both refuse before spending, so no item is lost.

**Known broken on t106dev, now `ivan/next-release` (not architecture):** `tests/test_aggregate_production_demand.js`
fails before and after the 2026-11-03 cleanup ("two genuinely free items already fill both buyers before a new lot", `expectedProfit` differs).
Also failing on HEAD before the honest-travel change, while listed as live: `test_bot_equipment_transition_recovery`,
`test_party_companion_rest_follow`, `test_producer_preparation`, `test_task4_arrival_step` ("invoke is not defined"),
`test_wish_purchase_supply`, `test_bot_hunting_visibility` (fails already at 9f27b7fa), `test_bot_wtb_standing_order`, `test_task4_b5_role_change`.
Known red in `notRunTests`: `test_beginner_shot_policy`, `test_finite_market_income`,
`test_gear_intermediate_candidates`, `test_task4_survival_tranche`.

## Agreed order (2026-11-03)

0. Done 2026-11-03: PvP and CP fixes from [c4-check.md](c4-check.md) (CMB-4, and CP for summon damage): `PvpRules` (ff564a01);
   death, PK drops and respawn by C4 (b786dc02).
   Left: support casts do not flag (CMB-21), owned quest NPCs count as summons in PvP memory (CMB-22).
1. Flags become the behaviour: `coldHonestTravel`, `coldSoloWindow`, `coldMomentGate` (all done: 10404b7e,
   be5c09f7, 13a7ba29; shadows with them).
2. Delete the scripted PK role (POP-17); own changes: actor-publication pipeline (WOR-5), social graph (PER-4, after
   the named-migration scheme is agreed with Slava).
3. Make failures visible (theme 1; POP-1 and the process backstop done).
4. Atomic value moves (PER-1, PER-2).
5. C4 check against L2J Mobius C4 (combat done: [c4-check.md](c4-check.md)), then one function per hot/cold rule (theme 2).
6. Large plans, each after the perf tool: board publication (ECO-1), cold-bot record audit (PER-7), bot warehouse
   (PER-9), incremental decision, cold walker route, one movement engine (WOR-1).

Decided without the maintainer, by the rules above: one "is a bot" rule (WOR-3), one town identity (WOR-6), one
hot/cold transition (POP-4), start-up repairs removed after their cause is found (PER-11).

## Planned features

- Cold walker visible on its road: [../cold-walker-route/plan.md](../cold-walker-route/plan.md).
- Recompute only the link a change touches: [../incremental-decision/plan.md](../incremental-decision/plan.md).

## Decisions only the maintainer can make

Each area file ends with its open questions. The ones that block the order above:

- Flags (POP-10, ECO-10): which side of each wins?
- Dead code (POP-12, WOR-5, PER-4): confirm nothing is coming back.
- ECO-1: is the worker plan the only publisher?
- PER-7: which copy is the truth for a cold bot?
- WOR-1: one movement engine, and which?

## Decisions 2026-11-03 (second batch)

- `.admin` and admin bypasses stay open to every player (solo game); README says so.
- Static "Shots:" merchants sell only no-grade shots (C4: D-S only in the GM shop 300511, Lisvus `merchant_buylists`);
  D-S come from crafting, the board or the admin panel. `staticShotsDisabled`, `FixedShotOffers` and the
  `allowsFixedShot` branches go: one rule for bots and the player.
- Disabled quests: add the missing quest-item templates (7077, 7162, 7173-7181, from the Lisvus datapack), enable
  Q035, Q038, Q039, re-check the reasons of the other 13 (pass2-dormant D4).
- Death wait: no fixed number. One function for hot, cold and `EconomicValuation`: wait while a realistic revive
  chance exists (a living party/clan member nearby with a resurrection skill and MP, or a scroll, not in combat), capped
  by a config limit (e.g. 2 min, in limits.md); without a chance, a short pause from the persona via `TendencyRoll`
  (~2-15 s). Replaces 12 s hot / 90 s cold (pass2-rule-numbers N1).

## Found by perf-tooling / e2e (2026-11-03, not fixed there)

- "Is a real player" has 8 separate predicates (`PlayerActivitySignal.isRealPlayerSession`, `BotAI`, `HotActorLodPolicy`,
  `BotTradeService`, `BotBrain`, `BotAgentTools`, `DevConsole`, `World`); part of WOR-3.
- `Request/Appeared` sends the player's UserInfo to others too.
- Adena is granted by three paths (`TradeService.giveAdena`, `AdminGiveAdena`, ...), each writing DB and backpack.
- `awardBaseGear` exists twice (`BotManager`, `CreateNewChar`).
