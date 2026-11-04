# Second pass: one rule written as a number in several places (2026-11-03, t106dev)

Checked at 199c3b19 (2026-11-04).

Verified on the main checkout (t106dev + uncommitted). Known (skipped): AI-4, CMB-5, CMB-18, WOR-6, WOR-9, AI-11, WOR-7,
CMB-1/2/6/17, POP-8, ECO-2/4. Paths relative to `src/GameServer/`.

| # | Rule | Values and places | Owner | Disagree | Suggested owner |
|---|---|---|---|---|---|
| N1 | Wait after death before town restart | hot `BotAI` ~591 = 12 s; cold `BackgroundResolver` ~331 = 90 s; `EconomicValuation` ~150 prices 90 s | none | **12 s vs 90 s** | one death-recovery constant (check C4) |
| N2 | Newbie Guide level cap | NPC `NpcBypasses/NewbieBuff` 25; bots `BotBuffs.NEWBIE_GUIDE_MAX_LEVEL` 20 | BotBuffs | **25 vs 20** | one constant (check C4) |
| N3 | Bow range | `AttackRange` 700 + `pAtkRangeAdd`; `BotAI` ~783/944 passes fixed 700 (drops Long Shot); cold keeps the bonus; `PartyPulling` 700 | AttackRange | **hot archers ignore Long Shot** | AttackRange |
| N4 | Rest "done" line | `RestPolicy.restOver` (solo `THRESHOLDS.rested` via `restedLine`, party locked 0.95; `RestingState`, `resolveRest`, `RestPotion`); literal copies in BotAgentTools, FollowingState, VisitNeed; `ClanAllianceQuestAI` wakes at **0.85/0.8** | RestPolicy | yes (alliance) | RestPolicy |
| N5 | Solo rest line | RestPolicy 0.35/0.20; copies in BotAmbientDirector, ClanAllianceQuestAI, BotPvpTactics, PartyCombatLootPolicy | RestPolicy | agree | RestPolicy |
| N6 | Emergency heal | 0.45 in FollowingState, ClanAllianceSupportAI, PlayerPartyRaid, PartyClassTactics; `PartyHealPolicy` treats HP ≤ 0.35 | PartyHealPolicy | **0.45 vs 0.35** | `PartyHealPolicy.EMERGENCY_BELOW` (proposed) |
| N7 | Party heal line | HEAL_BELOW 0.7; literals in BackgroundResolver, PlayerPartyRaid, PartyRevivalService, PartyCombatLootPolicy; `ClanAllianceSupportAI` **0.85** | PartyHealPolicy | yes (alliance) | PartyHealPolicy |
| N8 | Raid level window | `RaidCurse` max diff 8 (combatLevel); `ClanRaidPolicy` own 8 and floor −5; `OpportunisticRaidPolicy` floor max(20, boss−2), +8/+7; more +8 in OpportunisticRaidDirector, ClanEquipmentPartyPolicy; `PartyRequestPlanner` 7 | RaidCurse | **floor −5 vs −2; level vs combatLevel** | RaidCurse + one raid-admission module |
| N9 | Inventory slots | `InventoryLimits` 80 / dwarf 100 / +6 per Expand; `Database.exchangePetTicket` `>= 80`; `ItemDisposition.INVENTORY_SLOT_LIMIT` 80 (no reader); `SurvivalFloor` 80; `EconomyContext` ignores Expand | InventoryLimits | **dwarves / expanded bags blocked at 80** | `InventoryLimits.forState/forActor` |
| N10 | Skill reuse | 3rd copy in `ClanRaidEstimate` (no Mastery, 250 ms floor) | (CMB-1) | partly | Skills/SkillReuse |
| N11 | Cast time | `Formulas.calcSkillHitTime` (spiritshot 0.7, 500 ms floor); bare `333/castSpd` in WishProviders, BotTargetMatchup | Formulas | yes | Formulas |
| N12 | Default attack speed | 333 (ClanRaidEstimate, Actor) vs 300 (BotTargetMatchup, OpportunisticRaidPolicy, RaidRosterPriority); mob 253 | none | **300 vs 333** | Formulas default |
| N13 | Run speed | `ClanHall/ColdVisit` `/120`; fallbacks 120 in MoveTo, EffectRestrictions, TownTraffic | ColdTrip.RUN_SPEED | agree | ColdTrip |
| N14 | "In town" radius | 7500 (VisitNeed, BotImprovementService, TownServiceCatalog, NpcShopBuyLists, HotTownRebuff, TownTransitPolicy, FollowingState); 6000 ColdTrip; 3000 TravelRoutes; 1500 HotTownRebuff, FollowingState | none (WOR-6) | **1500/3000/6000/7500** | WOR-6 town module |
| N15 | Support range | 900 in BotManager, BuffService, BuffServiceChat, BotAgentTools, BotPvpTactics, PlayerPartyRaid, FollowingState; hot party 450 | none | mostly | one SUPPORT_RANGE |
| N16 | Mob chase break | `Npc` 1500 literal; `DangerRule.CHASE_BREAK_DISTANCE` 1500 | DangerRule | agree | Npc constant |
| N17 | Hunt level window | SpotService −7/+3; BotTargetScorer −7/+8 + literals; −15 floor in 3 places; LevelingRoutes ±3; SpotProfiles ±4 | SpotService | spot +3 vs target +8 | SpotService |
| N18 | MP held back from attacks | `BotClassPolicy.profileFor` support 0.25/0.45/0.30, mage 0, tank 0.20, others 0.10; fallback for a class without a profile `BotClassPolicy.reserveRatio` support 0.45, mage 0.18, others 0.10 (the budget, `offensiveMpReserve`, gives a mage 0; the 0.18 is read only by `BotCombatUtility`'s defensive-stance score); buff floor 0.35 | BotClassPolicy | **solo support 0.25 vs 0.45; mage score 0.18 vs budget 0** | BotClassPolicy |
| N19 | Party size 9 | `PartyCompanionService.MAX_PARTY_MEMBERS` (no outside reader); ~46 literal 9s | — | agree | one constant |
| N20 | SoE cast 20 s | C4SkillRules, TripPayment, BotSpotTravel | C4SkillRules | agree | C4SkillRules |
| N21 | Corpse / sweep window | SpoilSweep 30 s; NpcDied retry 25 s; PendingSweep 30 s | SpoilSweep | minor | SpoilSweep |

Clean (one owner): regen tick, NPC sell half price, party EXP bonus, aggro range, deep blue, enchant safe level, shot
multipliers, activation radius; PvP flag 15 s (two agreeing copies). Starter-region radii differ on purpose.
