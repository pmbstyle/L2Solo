# Findings of the category passes

Checked at 544a99e8 (2026-11-04).

Open findings of the category passes (README "Category passes"), one row each, grouped by category. A pass writes its
new rows here; a fixed finding's row is deleted in the commit that fixes it. Ids are the ones the passes gave and
are unique within a category (purity R1-R12 and races R2-R15 are different findings: cite them as "purity R6",
"races R6"). Line numbers drift; search by name. Paths relative to `src/GameServer/` unless they start with `src/`.
Confidence: C or reading = the path read to its end, P or probe = a node probe, G or guess = not traced to the end.
Area debt (AI, POP, ECO, CMB, WOR, PER, TBL ids) lives in the area files and [debt.md](debt.md), not here.

## Dead and always-taken branches

| # | Where | What is wrong | Impact | Fix |
|---|---|---|---|---|
| DB1 | `ProductionPolicy`, `FixedShotOffers` (~45 lines), `TradeService`, `MarketOpportunity`, `WishPurchaseEvidence`, `StaticMerchantPricing` | `staticShotsDisabled` default true since T106 ("C4: no NPC sells D-S shots"); only one test sets false | dead by default, test-only knob | decided: goes (debt.md, "Decisions 2026-11-03") |
| DB2 | `ProductionPolicy.buyersDisabled()` (13 sites) | `staticBuyersDisabled` default false, set only by 4 tests | test-only knob | delete, or keep as an operator knob (ask) |
| DB3 | `NpcObjectIndex.find/nearTemplate/nearestOfTemplate` scan fallback; `HotBackgroundParty` ~383 `isIndexed` | index built in `World.init`; the fallback serves only a boot window | dead after boot (test worlds never build the index) | build the index in test worlds, drop the fallback |
| DB4 | `World.fetchNpcsInRadius` (`typeof` / `?.()`, 9 sites), `World.isBotSession`, `World.fetchVisibleUsers` (`ClanWarRuntime`), `World.updateUserLocation/Presence` (`Model/Actor`) | targets always defined; else returns `[]` silently | dead guards for test doubles | debt.md theme 6 |
| DB5 | `CharacterLocationIndex` `legacyStateCache` | only `false` user is `CharacterActorSources` (WOR-5) | dead after WOR-5 | delete with WOR-5 |
| DB6 | `Database.js` ~3325 pricing cursor without `seenAt`, ~11274 legacy receipts, `BotAfkMarketService` ~364, `MarketPricing` ~93 | legacy branches, unproven either way | unknown | prove on a real world DB, then delete or keep |

Test hooks (`*_resetForTests`, `terminateForTest`) stay (cheap).

## Dormant features and dead config

| # | Where | What is wrong | Impact | Fix |
|---|---|---|---|---|
| D2 | Clan warehouse reservations (`reserveClanWarehouseItem`, `releaseClanWarehouseReservation`) | `reservedAmount` always 0 live, ~70 `amount − reservedAmount` checks guard nothing; tests only | ~80 lines + checks | delete or wire up |
| D4 | 16 disabled quests (`QuestRegistry`) | stated reasons stale for Q035, Q038, Q039 (NPCs/spawns now exist); real blocker: missing quest-item templates 7077, 7162, 7173-7181; `equipmentToolsByQuest` empty | 1624 lines unused | decided (debt.md "Decisions 2026-11-03"): add the templates, enable Q035/Q038/Q039, re-check the other 13 |
| D7 | Clan strategy / ClanBrain / LLM titles (`strategicManagementEnabled=true`, `llmGoalManagementEnabled=true`, `llmTitleManagementEnabled=false`) | inert without OpenRouter (off by default): "legacy deterministic lifecycle" is the real behaviour (`ClanStrategyService.review`) | ~900 lines | say so in config, or delete |
| D8 | `staticShotsDisabled=true` | `FixedShotOffers` and `allowsFixedShot` dead, while 16 static "Shots:" store bots still sell D-S shots to players (MerchantStoreConfigs ~384), against its own "C4: no NPC sells D-S shots" | 33 lines + 8 sites; players buy D-S shots | decided: no-grade shots only, the knob goes (debt.md) |
| D9 | `staticBuyersDisabled=false` | A/B knob, true branch in ~12 sites, tests only | ~12 sites | with DB2 |
| D12 | ~8 Database one-liners (`deleteCharacterQuest`, `deleteGearItems`, `deleteShortcuts`, `deleteMacros`, `updateCharacterName`, `updateWarehouseItemAmount`, `deleteWarehouseItem`, `fetchAutonomousClanOperation`) | no caller | ~30 lines | delete |
| D14 | `.admin` panel (`Speak.js` ~147), Admin* bypasses, UiTest | **reachable by any player; `fetchIsGM` never checked** | note | decided: stays open (debt.md) |
| D15 | `GameServer.pvp`, `GameServer.maxOnline` | cosmetic bytes in the server list (`ServerList`), not enforced | none | enforce or drop |
| D16 | `devLogPlayerChat=true` (Speak ~21) | needs `developerDiagnostics` too | misleading default | one switch |

## Fields written but never read, or read but never written

| # | Where | What is wrong | Impact | Fix |
|---|---|---|---|---|
| F1 | `BotImprovementPolicy` ~202; dead readers `Database` ~8383, `BotImprovementService` ~140, `ColdSoulCrystal` | bots never start the soul crystal quest (Q350): the only producer of `kind:'crystal_quest'` went with 82e5323c (2026-10-09) | only bots with an old Q350 row progress | restore the producer or delete the path |
| F2 | `Database.tradeMeetingPositionUnsafe` ~11399 | a hot bot in combat counts as available for a trade meeting: `state.fetchAttacks()` does not exist (State has `fetchHits`) | meetings with fighting bots | read `fetchHits` |
| F3 | `BuffService` ~46, ~334 | buffer "busy" ignores movement: `state.fetchMoves()` does not exist | moving buffer/buyer never refused | read the real move state |
| F4 | `PlayerPartyTakeover` ~78 vs `ClanEquipmentService` ~171 | reads `stats.clanOperation`, written only as `stats.objective.clanOperation`: clan-equipment parties not recognised as operations | player may take over such parties (likely) | read the written key |
| F5 | `ClanHall/VisitPolicy` ~31 | cold clan-hall visit reads `stats.clanAllianceQuest`, which exists only on the hot session | alliance duty ignored cold (if possible cold) | carry it in stats or drop the cold read |
| F6 | `Actor/Backpack` ~467 | `session.tryPlaceMercTicket` / `mercTicketManager` never set | mercenary tickets: silent no-op | implement or refuse visibly |
| F7 | `ColdSimulationOwner` ~32 | `options.hasWarehouseWorkflow` never passed (one test only): the `warehouse_state` refusal never fires | guard dead | pass it or delete |
| F8 | `BotNegotiationService` ~192, `ClanHall/Repository` | tables `bot_negotiations`, `clan_hall_events` written, never read or pruned | grow forever | prune or stop writing |
| F9 | Worker ~2187, Coordinator ~752, Protocol ~154 | worker ↔ main sanity data ignored: `ready.data` catalog sizes, `init.catalogVersion`, envelope `sentAt` | mismatched catalogs undetected; no latency | compare at ready |
| F10 | `BotHuntEfficiency` ~149 | `stats.pvpIntent` never written (only competition events carry `pvpIntent`): the `risky` ×0.5 loss-hours never applies | risk misjudged | feed it or drop it |
| F11 | `BotManager` ~242, `NativeStatus` ~66 | `goal.plan.personaDrive` writer removed (d4322a21) | "wealth" label never shown | drop the label or restore |
| F12 | cold `stats`: `lastMarketPurchase`, `lastImprovement`, `lastClanContribution`, `lastClanWarehouseTransfer`, `lastWarehouseDeposit`, `lastRespawnAt`, `coldCompetition.endedAt`, goal `requiredAdena`; WorldObserver-only `expEarned`, `spEarned`, `adenaEarned`; party `statsJson` `lastResolveAt`; hot session `preShopLocation` (no reader on purpose), `targetAcquiredAt`, `pendingBrainTurn` (code uses `pendingBrainTurns`); DB columns `afk_trade_shops.closedAt`, `afk_trade_lines.initialCount`, `clan_operation_members.reservedAt/releasedAt`, `board_trade_meeting_lines.sourceAdRevision`, clan goal `orderRevision` | written, nobody reads | bytes on every commit | delete (some are test evidence, debt.md theme 6) |
| F13 | `stats.clanEquipmentOrder`, `stats.craftService`, `stats.routeRole`, `stats.pkKills`, `session.botTrade` (redundant guard in 7 item services), `session.partyRole` / `isSimPlayer` / `simPlayer`, `session.workerCommand` (diagnostic), `offer.onceReward` (dead quest option); table `clan_hall_startup_schedule` (written only by tests: operator hook?) | read, never written | harmless fallbacks | delete the reads |

## Game logic

Checked against Lisvus C4. Ordered by impact.

| # | Where | What is wrong | Impact | Fix |
|---|---|---|---|---|
| L24 | `BotTownTravel.returnSupplyHot` ~106 | after 4 failed hot writes a supply errand's return resumes the AI anyway (`population.supply_return_cold`): the bot plays hot with a cold, unfenced row, the two-owner state 352fa954 removed | rare (reading) | one owner: stay parked and leave it to the cold path, or fence until a write lands |
| L25 | `AfkTrade/TradeMeetingService.processMeeting` | an accepted meeting has no age limit: a cold side fighting or resting is skipped and progress waits on events; meanwhile `MeetingAnchor.compatible` limits all its trades to the point and `partyTradeAllowed('party')` keeps it out of parties | stuck bots (guess) | a meeting that ends (our design, not C4) |
| L26 | `ColdSimulationCoordinator.releaseFence`, `HotPartyLifecycle.activate`, `PvpEncounterLifecycle.activate` | `fencedBots` is one Set: a failed party or PvP activation's `finally` releases every id it fenced, including a member who left meanwhile and is now fenced by another owner | reading; frequency guess | release only fences this owner holds; `handoffToMain` CAS is the backstop (races R6) |
| L27 | `Database.applyColdPhysicalStateUnsafe` ~3030 and the death wash ~3065 | cold karma wash falls short when one round both gains EXP and ends in death: the commit washes the net gain `max(0, exp − old)/260` plus the death's `karmaLost`, so X gained and Y lost washes X/260 (Y < X) or Y/260, not (X+Y)/260; `stats.karma` is then overwritten from `characters` | PKs wash slower cold (reading) | Lisvus washes on each `addExp`, gain and death loss alike |
| L28 | `BotDecisionService.groundLook` vs `BackgroundResolver.admittedShares` / `routeRefuses` | hot ground look judges spawns with `{ soloSafety: true }` only; cold adds the recovery `maxTargetLevel` (`soloPickOptions`), so under a recovery a hot bot keeps a ground cold would raise | hot/cold drift (reading) | one option set hot and cold |
| L5 | `ColdSimulationKernel.lifecycleKind` returns `resolver` for any karma first; `ColdKarmaPolicy.plan` clears equipmentPlan, marketReturn, craftReturn, supplyErrand, warehouse* | cold bots with karma never trade; errands wiped each step; no spot → `resting` without `restUntil` | all "PK trades in Floran" code unreachable cold; hot walks to Floran from anywhere (reading) | one rule hot/cold (design 5.8) |
| L6 | `ColdSimulationKernel.lifecycleKind` ~421 | unreachable "traveling with market reason → command" branch, after ~390 returns `resolver` for every `traveling` | dead or lost route (reading) | delete or move up |
| L7 | `AI/BotBuffs.applyFullNewbieBlessing` (`setHp`/`setMp` to max), `RestingState.beginNewbieGuideRecovery`, `HotTownRebuff` | Newbie Guide fully heals bots; resting uses it as a heal | free recovery (reading) | C4 Newbie Guide only buffs |
| L8 | `NpcSellRules.npcBuyPrice` `max(1, …)` | NPC pays ≥ 1 adena for a 0-price item | an adena source (reading) | C4 `price / 2` = 0 |
| L9 | not implemented | non-PK killed by monsters never drops items | guess | Lisvus `PlayerRateDrop` (C4 config) 5 % above level 4; check Mobius defaults first |
| L10 | `RestingState.js` ~283 | `session.townGossip` never set true; "stay seated forever" branch | dead, no exit if ever set (reading) | delete |
| L29 | `Database.transferInventoryToWarehouse` (bots: `BotWarehouseService`, a companion's overweight `unload`) | a bot's warehouse has no slot cap (the player's account warehouse is capped by `PersonalWarehouseLimits.playerCapacity`; `PersonalWarehouseLimits.forActor`, 100/120 + Expand, is not checked on deposit) | unbounded bot warehouses (reading) | C4 100 slots, 120 for dwarves (Lisvus `WAREHOUSE_SLOTS_*`) |

## One rule written as a number in several places

| # | Where | What is wrong | Impact | Fix |
|---|---|---|---|---|
| N1 | hot `BotAI` ~622 = 12 s; cold `BackgroundResolver` ~344 = 90 s; `EconomicValuation` ~150 prices 90 s | wait after death before town restart: no owner, **12 s vs 90 s** | hot/cold drift | decided (debt.md "Decisions 2026-11-03"): one death-wait function |
| N2 | NPC `NpcBypasses/NewbieBuff` 25; bots `BotBuffs.NEWBIE_GUIDE_MAX_LEVEL` 20 | Newbie Guide level cap **25 vs 20** | bots lose 5 levels of buffs | one constant (check C4) |
| N3 | `AttackRange` 700 + `pAtkRangeAdd`; `BotAI` ~817/978 passes fixed 700; cold keeps the bonus; `PartyPulling` 700 | bow range: **hot archers ignore Long Shot** | hot/cold drift | `AttackRange` |
| N4 | `RestPolicy.restOver` (solo `THRESHOLDS.rested` via `restedLine`, party locked 0.95; `RestingState`, `resolveRest`, `RestPotion`); literal copies in BotAgentTools, FollowingState, VisitNeed; `ClanAllianceQuestAI` wakes at **0.85/0.8** | rest "done" line differs (alliance) | alliance bots rest differently | `RestPolicy` |
| N5 | RestPolicy 0.35/0.20; copies in BotAmbientDirector, ClanAllianceQuestAI, BotPvpTactics, PartyCombatLootPolicy | solo rest line copied (values agree) | drift risk | `RestPolicy` |
| N6 | 0.45 in FollowingState, ClanAllianceSupportAI, PlayerPartyRaid, PartyClassTactics; `PartyHealPolicy` treats HP ≤ 0.35 | emergency heal **0.45 vs 0.35** | healers disagree | `PartyHealPolicy.EMERGENCY_BELOW` (proposed) |
| N7 | HEAL_BELOW 0.7; literals in BackgroundResolver, PlayerPartyRaid, PartyRevivalService, PartyCombatLootPolicy; `ClanAllianceSupportAI` **0.85** | party heal line differs (alliance) | alliance heals earlier | `PartyHealPolicy` |
| N8 | `RaidCurse` max diff 8 (combatLevel); `ClanRaidPolicy` own 8 and floor −5; `OpportunisticRaidPolicy` floor max(20, boss−2), +8/+7; more +8 in OpportunisticRaidDirector, ClanEquipmentPartyPolicy; `PartyRequestPlanner` 7 | raid level window: **floor −5 vs −2; level vs combatLevel** | raid admission disagrees | `RaidCurse` + one raid-admission module |
| N9 | `InventoryLimits` 80 / dwarf 100 / +6 per Expand; `Database.exchangePetTicket` `>= 80`; `ItemDisposition.INVENTORY_SLOT_LIMIT` 80 (no reader); `SurvivalFloor` 80; `EconomyContext` ignores Expand | inventory slots: **dwarves / expanded bags blocked at 80** | lost capacity | `InventoryLimits.forState/forActor` |
| N10 | `ClanRaidEstimate` (no Mastery, 250 ms floor) | a 3rd copy of skill reuse | estimates off | Skills/SkillReuse (CMB-1) |
| N11 | `Formulas.calcSkillHitTime` (spiritshot 0.7, 500 ms floor); bare `333/castSpd` in WishProviders, BotTargetMatchup, RaidHealingEstimate | cast time copied without the floor and shot | estimates off | `Formulas` |
| N12 | 333 (ClanRaidEstimate, Actor) vs 300 (BotTargetMatchup, OpportunisticRaidPolicy, RaidRosterPriority); mob 253 | default attack speed **300 vs 333**, no owner | estimates off | a `Formulas` default |
| N13 | `ClanHall/ColdVisit` `/120`; fallbacks 120 in MoveTo, EffectRestrictions, TownTraffic | run speed copied (agrees) | drift risk | `ColdTrip.RUN_SPEED` |
| N14 | 7500 (VisitNeed, BotImprovementService, TownServiceCatalog, NpcShopBuyLists, HotTownRebuff, TownTransitPolicy, FollowingState); 6000 ColdTrip; 3000 TravelRoutes; 1500 HotTownRebuff, FollowingState | "in town" radius **1500/3000/6000/7500**, no owner | town checks disagree | the WOR-6 town module |
| N15 | 900 in BotManager, BuffService, BuffServiceChat, BotAgentTools, BotPvpTactics, PlayerPartyRaid, FollowingState; hot party 450 | support range, no owner (mostly agrees) | drift risk | one SUPPORT_RANGE |
| N16 | `Npc` 1500 literal; `DangerRule.CHASE_BREAK_DISTANCE` 1500 | mob chase break copied (agrees) | drift risk | an `Npc` constant |
| N17 | SpotService −7/+3; BotTargetScorer −7/+8 + literals; −15 floor in 3 places; LevelingRoutes ±3; SpotProfiles ±4 | hunt level window: spot +3 vs target +8 | spot and target disagree | `SpotService` |
| N18 | `BotClassPolicy.profileFor` support 0.25/0.45/0.30, mage 0, tank 0.20, others 0.10; `BotClassPolicy.reserveRatio` (fallback) support 0.45, mage 0.18, others 0.10 (the budget, `offensiveMpReserve`, gives a mage 0; the 0.18 is read only by `BotCombatUtility`'s defensive-stance score); buff floor 0.35 | MP held back from attacks: **solo support 0.25 vs 0.45; mage score 0.18 vs budget 0** | stance score and budget disagree | `BotClassPolicy` |
| N19 | `PartyCompanionService.MAX_PARTY_MEMBERS` (no outside reader); ~46 literal 9s | party size 9 copied (agrees) | drift risk | one constant |
| N20 | C4SkillRules, TripPayment, BotSpotTravel | SoE cast 20 s copied (agrees) | drift risk | `C4SkillRules` |
| N21 | SpoilSweep 30 s; NpcDied retry 25 s; PendingSweep 30 s | corpse / sweep window (minor) | edge sweeps | `SpoilSweep` |

## Silent failures and masking defaults

A failure a catch survives goes through `FailureLog` (counted by site, the first logged, status `swallowed=`).

| # | Where | What is wrong | Impact | Fix |
|---|---|---|---|---|
| S1 | `BackgroundResolver` ~1729, ~2155 | `npcForSpot(...) \|\| { maxHp: max(1, spot.mob?.hp \|\| 1), pDef: 1, … }` | high: no template → a 1-HP mob with the spot's real rewards: free cold EXP and drops | refuse the spot (counted) |
| S2 | `BotAI/SpotValueTable` ~152 | geodata manifest read → null | low: spot values missing | count it |
| S3 | `ColdSimulationCoordinator` ~1964 | `flatMap → []` drops bad requests with no ack (counted, `cold.request_dropped:<why>`) | med: worker waits on a command that never returns | ack the drop (debt.md theme 1) |
| S4 | `Inventory/ShotStock` ~651 + `Bot/TradeService` ~425-443 | catch-all around buys; failed refund only attached to the error (counted, `shots.store_buy`) | med-high: adena lost, no item | PER-2 |
| S5 | `Database` ~3597/3630 | AFK credit `Math.max(1, … \|\| 1)` | low: 0/NaN becomes 1 (latent) | refuse a bad amount |
| S6 | `ProgressionRates` ~79, ~227, `NpcShopPriceScale` ~2 | `Math.max(1, rate \|\| 1)` | low: rates below 1 ignored | allow rates below 1 or say so |
| S7 | `PopulationService` ~2411, ~2885 (`schedulerLagThrottleMs`) vs `ColdSimulationCoordinator` ~317, ~2263, `BackgroundWorkGovernor` ~142, `FloorAwareActivationPolicy` | `\|\| 40` vs `\|\| 0` for the same "0 = off" config | low: config 0 means off in one place, default in another | one reader per key |

## Client entry points: crashes, accidental dupes and losses

Scope: request handlers, NpcTalkResponse + NpcBypasses, Speak `.` commands, UserCommand. Deliberate cheating for gain
is out of scope (the admin panel is open to all by decision). Ordered by likelihood in normal play. `Server.js` only
catches what a handler returns; anything else reaches the process backstop (`NodeL2`).

| # | Where | What is wrong (normal-play trigger) | Impact | Fix |
|---|---|---|---|---|
| X2 | `Backpack.dropItem` ~228 → `World.spawnItem` | drop a +N item, pick it up: enchant not passed (PK drop passes it) | comes back +0 (C) | one ground-spawn helper keeping enchant and pet data |
| X3 | `NpcBypasses/GatekeeperTeleport` | double-click a destination: no `pendingActorTeleport` check, adena taken before the delayed move | fee charged twice (C) | refuse while `pendingActorTeleport`; fee inside the teleport commit |
| X4 | `PurchaseItem.awardItem` ~30, `Bot/TradeService.giveItem` ~222 | buy 2 rings at an NPC / static merchant | one non-stackable row with amount 2; spreads into trades and bot inventories (C) | one amount-1 row per non-stackable |
| X6 | `Speak.consume` ~267, `.tell/.invite/.joinparty` ~200, `BotManager.handlePlayerSpeak`, `BotRemoteChat.replyForStateNow`, `World.askForTeamUp` → `inviteBotByName`, `RequestPledgePower`, `CrystallizeItem` | /tell a bot, party chat with LLM, invite a cold bot: a rejection in these unobserved chains reaches only the process backstop (logged once, counted) | `inviteBotByName` throw leaks party capacity (C missing catch, G rejects) | handlers return their promises |
| X7 | buffered `deleteItem` vs direct awards (`useExtractableItem` ~517, `useRecipeItem` ~477, `QuestService.giveItem`, PER-1, PER-2) | any crash or stop between steps | award saved, consumption lost; half-moved NPC buy / merchant deal; logout during PER-1 100 ms steps = paid, nothing received (C) | one owner for every stack change (PER-3) |
| X8 | read → await → absolute write: `PurchaseItem.awardItem`, `SellJunk` ~93 (`.sell`), `QuestService.giveItem/takeItem` vs buffered deletes and warehouse/enchant/pet transactions | `.sell` while companions loot; shots spent during pickup; deposit during a party adena split | one gain overwrites another: adena lost or created, memory ≠ DB (C pattern, G window) | relative SQL deltas in transactions (PER-3) |
| X9 | `Bot/TradeService`, TradeDone commit, `AfkTradeService.refreshActorInventory` ~530 | an item change while a bot trade commits | items can be duplicated; a used potion comes back in memory (C, G timing) | with X8 |
| X10 | ~25 quests (Q034 ~64, Q410, Q406, Q002, Q001) | turn-in while the stack changes / a write fails: several unchecked `takeItem`s then `giveItem` | reward without full cost (C) | quests on `QuestStep.apply` (PER-3) |
| X11 | `Crystallize.js` (0x72) | crystallize +4 or higher: `fetchCristals()` instead of `C4EnchantRules.crystalCount` | too few crystals, two rules (C) | one crystal rule |
| X12 | `CharDelete` → `Database.deleteCharacter` | delete a clan leader | leaderless clan, stuck bot members, locked warehouse (C4 refuses) (C) | refuse leader delete |
| X13 | `ClanWarehouse.withdraw` (transaction per line); `NpcBypasses/Clan.spendLevelCost` ~138 | multi-line withdraw; clan level-up while dead / pet-locked item | partial withdraw; SP lost and `clanLevelUpPending` stuck (C) | batch clan withdraw; one transaction per clan level-up |
| X14 | `TradeService.buyFromStore` ~362 / `sellToStore` ~448 | static merchant deal: two writes | undo returns the item at +0; silent undo failure (C) | the atomic methods (PER-2) |
| X15 | `PrivateStoreBuy` ~17 (`count > 4`) | pick 5+ lines from an AFK shop (12 allowed) | refused with ActionFailed only; packages bought line by line can end half-sold (C) | accept the shop's line count |
| X16 | `Restart`, `Logout` vs `Session.error` | restart in a bot trade / with companions: no `BotTradeService.cleanup`, no `detachAll` | destroyed actor kept; companions carry to the next character (C path, G impact) | one `Session.leaveCharacter` (proposed) teardown for error, Restart and Logout |
| X17 | `Select` ~193-247 | a throw in the click handler: the catch treats it as "unknown object" | sends `deleteOb` for a live target (C mech, G trigger) | catch only the lookup |
| X18 | `buyFromLivePrivateStore`, `transferInventoryBetweenCharacters`, `afkTradeCreditAdenaUnsafe`, `TradeService.giveAdena` | rich seller: only NPC sale caps adena | adena above 2^31-1, client shows negative (C) | one adena cap 2^31-1 |
| X19 | `NpcTalkResponse` `activeNpcTalk` (cleared only on a character change, `Session.setActor`); BuyShop, HennaRemove, NewbieBuff heal | link from an old dialog: stale dialog state | NPC services reachable away from the NPC; henna removal free (C4 charges) (C) | one interaction guard |
| X20 | `NpcTalkResponse` ~60 (`invoke` of `NpcBypasses/` + handler name) | crafted bypass name: not checked against the bypass list, so a path outside `NpcBypasses/` can be loaded; the `html` bypass path is not normalised either | C/P crafted | bypass allow-list, `html` path normalised |
| X21 | `ValidatePosition` ~42 | crafted coordinates accepted and persisted | note only (C crafted) | — |
| X23 | `CubicControl.summon` timers | disconnect with cubics: timers keep running on the destroyed actor | G | clear them in the teardown (X16) |

## Purity and determinism

Goal (CLAUDE.md): rules are pure functions of plain data, deterministic, owned once. Live hot combat rolls and
cosmetic randomness stay as they are.

| # | Where | What is wrong | Impact | Fix (size) |
|---|---|---|---|---|
| R1 | BotRevenge, BotMobCompetition, BotPvpDefense, BotConflictParticipation | hot revenge / mob competition / PvP defense / conflict participation roll `Math.random` | **hot/cold drift**: cold said "no" to a pair, hot re-rolls "yes" right after activation | roll with the cold `TendencyRoll` key + bucketed time (M) |
| R2 | `PopulationService.createBackgroundParty` ~944 | party cohesion, risk, first `nextResolveAt` unseeded | cohesion scales party fight windows and income: same roster, different yield | seed by partyId (S) |
| R3 | `BotTargetMatchup.profileBonus` ~224, `ColdCombatProfile.attackReach/profileReach` | `Date.now()` in a cache keyed only by profile | cold mob choice and fights per round follow wall time | take `at`, key caches by it (S) |
| R4 | `CraftProfitPolicy.succeeds` callers: ColdCraftingService, CraftWorkshopService, ManufactureShop, RecipeCrafting | craft success unseeded | a requeued cold retry re-rolls | one seeded roll (S) |
| R5 | `ColdSimulationKernel.lifecycleKind` (`mammonRetryAt`) | reads `Date.now()` | fake-clock tests route differently | read `this.now`/step time (S) |
| R6 | Worker economy/occupation/meeting/competition timestamps (Worker ~795, ~852, ~2004, ~2111) | decisions stamped with wall time | not reproducible | the step timestamp (S) |
| R7 | PriceBelief/PriceDecision | read MarketCounters module maps + a worker mirror | main and worker price from different rows while the mirror lags | a counters view in `ctx` (M) |
| R8 | `SpotProfiles.spotHunters` (`useOccupancy` per-thread switch) | per-thread crowd source | hot and cold see different crowds | take hunters in (M) |
| R9 | cold-entry `nextResolveAt` jitter (BotLifeState.writeColdRow, upsertState) | unseeded; it is part of the kernel's seed | first cold step not reproducible | seed it (S) |
| R10 | kernel `deterministicRandom` (a copy of `TendencyRoll.seeded`) | parallel mechanism; one stream per step, a new `rng()` call shifts every later roll | fragile reproducibility | TendencyRoll; later per-decision keys (M-L) |
| R11 | shared rules (BackgroundResolver, ColdCombatProfile, EconomyContext, WishProviders, PartyGoalPolicy); `HitRules.melee` `spreadRng` | ~445 `= Date.now()` defaults + ~99 `\|\| Date.now()`; `spreadRng` missing falls back to `Math.random` | a forgotten argument reads the wall clock | `timestamp` required; `spreadRng` defaults to `rng` (M) |
| R12 | `PartyCompanionService.randomMember` (a second implementation); clan-party drops (ClanActionService ~528) | two loot rules; unseeded drops | hot/cold drift | hot party loot through `PartyAgreement.allocate`; seed clan-party drops (M) |
| PU1 | `PartyAgreement.propose` first call (PopulationService ~951); `resolveSolo` without rng in BackgroundPartyResolver ~138, PopulationService ~118, ColdVisit ~93; PkProfiles.materializeBots; SpawnNpcs swaps the **global** `Math.random` around `random-point-in-shape` | `Math.random` (minor) | not reproducible | pass `rng` |
| PU2 | `GameTime.isNight` (host timezone `setHours`); `Uptime.SERVER_STARTED_AT` per thread drives MarketCounters decay; OpportunisticRaidPolicy.attack ~385; DecisionSections.stateView passes a misleading `Date.now()`; PetRules, ClanAllianceService timers | clock reads in rules | CI, laptop and a Rust port can disagree | pass time in |
| PU3 | PartyAdmission defaults reach BotLifeState/World; PartyHuntingTarget `stateOf` default = main cache; PersonaPartyPolicy/PartyGoalPolicy → BotPersona.of (missing persona → `accept: 'no_persona'`); BotPersona.ensure depends on creation order; DeathExperience mixes the pure rule with DB I/O; BuffServicePolicy, PartyArcherCombatPolicy, PartyCombatLootPolicy read World/LifeState; ColdKarmaPolicy imports SpotService in worker code | hidden lookups in rules | threads can disagree | inputs as arguments |
| PU4 | ColdCombatProfile attackerView/defenderView cached regardless of time; per-thread switches `EconomyContext.configure`, `ShotMarketIndex.configure`, `SpotValueTable.useSpots`, `MarketCounters.useSpots/useTable`, `RecomputeGeneration.configure` | module state mirrored main → worker | stale buffs on party/raid targets (guess); drift | inputs as arguments |
| PU5 | `ColdEconomyDecision.advisory` writes `state.stats.wishAdvisory`; `SpotRiskPolicy.marksInSteps`, `PartySpotRiskPolicy.marksInSteps` (one-time migration); HotActorLodPolicy, TownTransitPolicy write session state | input mutation in rules | hidden writes | return the change |

## Races and crash/shutdown data loss

Ordered by impact. Fact = code path read; guess = not traced to the end.

| # | Where | What is wrong | Impact (likelihood) | Fix / owner |
|---|---|---|---|---|
| R-A | `Backpack.deleteItem` (`Actor/Backpack.js`), `TrashItem`, `DropItem` | the packet's item count is not range-checked: an out-of-range count corrupts stacks (adena too) and persists; DropItem spawns the requested amount | crafted client (admin is open anyway) | `1 ≤ amount ≤ fetchAmount()`; spawn what was taken (Backpack) |
| R-B | `Purchase.consume` ~143 → `World.purchaseItems` with no shop; `PurchaseItem.awardItem` ~15 | a purchase is not tied to an open shop; an unknown item id never calls back and jams the character's `InventoryMutationQueue` (later pickups hang after the ground item left the world: loot lost; not verified) | crafted client | refuse with no shop; reject unknown templates |
| R15 | supply errand park/return: `BotSupplyErrand` (markCold `supply_errand`) → `BotTownTravel.returnSupplyHot` (markHot) | parked, the row is cold and the worker owns it while the actor stays in the World (hidden; at the destination `onArrival` restarts its hot AI, row still cold). After `expiresAt` (10 min, no meeting) the worker clears `supplyErrand` and hunts and commits; the return's `markHot` is a plain `save` of `mergeSessionIntoLifeState` with no fence or handoff: the worker's progress is overwritten, and the actor's later absolute writes roll it back. After 4 failed writes it resumes with the row cold (`population.supply_return_cold`, logic L24): two owners | expiry branch: an errand stuck > 10 min; give-up: rare | park as a real hand-back (actor detached, purchase as a command) or keep the row hot/fenced; return through the handoff CAS (POP-4) |
| R2 | `BotLifeState.upsertState`, `save` | full-row UPSERT without revision CAS (only `mindJson` is fenced); callers build the row before awaits (ClanOrderService ~253, ClanEquipmentService ~308/517/589, ColdShotEconomyService.persist ~235): a worker commit in between is overwritten (exp/level/adena/summary roll back; items keep the commit's bag) | narrow, under DB backlog | `save` takes `expectedRevision`, refuses stale |
| R3 | `upsertState`, `writeColdRow` fallback, `prepareResolve` persist, market saves | 4-6 separate DB jobs per write (row, location, EXP, vitals, trip payment); `upsertState` never writes `items`; plain EXP write skips the karma wash (the PER-7 one-copy writers) | crash for the split; summary-only write on every bag change | one transactional "life write" (row + characters + items) |
| R4 | `Database.withCharacterFlush` | the transaction's job writes the patch buffered up to its start (`applyJobCharacterWrites`), but transactions copy DB amounts back to memory as absolutes (also PersonalWarehouse, ClanWarehouse, PetInventory, QuestStep, BuffService, PrivateStoreTrade/AfkTrade refresh, `BotWarehouseService.depositActorAtWarehouse` → `source.setAmount`): a change made in memory between the job and its reply is overwritten | small amounts under load | publish deltas to memory |
| R5 | `Cooldown.cooldown` → `markCold` → `transitionToColdState` | the actor keeps ticking for ~2 upserts + accept (≤ 500 ms); `canCooldown` not re-checked; cache already cold so an invite activation passes; `loadAndSpawnBot` has no duplicate guard | every cooldown, small amounts | stop AI and detach first; one-step handover (POP-4) |
| R6 | `HotActivation` / `handoffColdSimulationToMain` | handoff bumps only the revision, `phase` stays cold until `markHot`: phase-only writers (board settlements, clan-hall dues, `payClanMember`, `ClanLevelSp.spend`) land in the window; `markDirty`/`snapshot_page`/`prepareProposal` ignore `fencedBots`; a cold save re-adds the bot (worst case simulated hot and cold). The boot full snapshot packs the rows it read at its start, so an early activation's old cold copy reaches the worker after the fence. `fencedBots` has no owner (logic L26) | plausible under load | `phase='activating'`; fenced bots refused; fence owner tokens |
| R7 | `fenceBot` vs `executeWorkerLifecycleCommand` | fence waits ≤ 500 ms then hands off; the command's later `upsertState(travel…)` writes a travelling row and maybe a payment onto a bot being spawned | under backlog | command writes under `withMutationAdmission` |
| R8 | `BotLifeState.refreshInventory` ~3307 | merges summary and items with `Math.max` per stack and adena: any divergence (R3, R5, R15, POP-22) becomes a duplicate | whenever copies differ | `items` wins (PER-7) |
| R10 | `saveBackgroundParty` (afterCommit `'party'` blind write; 12 more `createOrUpdate` callers) | no party CAS: `rowFromParty` drops `revision`, so a write prepared before an await overwrites the other writer's roster/stats (afterCommit carries `pendingRecruits` over by hand) | under load | callers carry `revision`, the save CASes on it (column exists, no migration) |
| R12 | clan money: `ClanPurchaseCredit.fund` → `acquire` → refund (separate transactions), `ClanWarehouseService.offerSpareGear` pays before transfer (`seenSpare` in memory), `resolveClanAction` no lease | treasury adena stays with the member; pays again after restart; `fund` twice | under load / crash | one transaction or a durable ledger |
| R13 | `PurchaseItems` ~37/49 (PER-1), `TradeService` (PER-2) | adena via buffer, items on `setTimeout`; logout → false; manual refund failure only logged | logout during a buy | `purchaseNpcInventoryBasket` |
| R14 | absolute read → await → absolute write (`TradeService.deductAdena/giveItem`, `QuestService.giveItem/takeItem`, `SellJunk`, `AdminGiveAdena`) | serialisation split three ways; lost updates | common for hot bots, small | one per-actor serializer, `amount = amount + ?` (PER-3) |
| R16 | worker restart; `acceptColdState` in HotActivation | a restart drops old-epoch acks (the named review never runs), waiters, economy decisions, meeting preparations (no value lost: CAS); the 500 ms `acceptColdState` timeout leaves a bot cold with no owner until the 30-min sweep | smaller | — |
| R17 | clan SP spend | a flush between commit and `publish` can write pre-charge SP | smaller | — |
| R18 | `player_anchors` (TradeMeetingService `publishPlayerAnchor`, `syncActors`) | publishes after an await: two meeting changes of one player can publish out of order and leave a stale anchor until the next change; advisory only (`prepareTrade` re-checks) | wrong refusals or a wasted preparation | — |
| R19 | `BotTradeService.inventoryCapacity` | trade weight does not count `PickupCapacity`'s pending awards: a pickup in flight and a trade can each pass | overload by one drop | count pending awards |

## Per-step cost

H = hot bots near players (100-300 in a crowd); "est." = reasoned, not measured. Measured: 22,348 NPC spawns; NPCs
in a 3×3 grid window median 100, max 749; `EffectStore.list` with 25 effects 8.3 µs; a `bot_life_state` row ≈
statsJson 6.4 KB + mindJson 1 KB + inventorySummary 2.9 KB. Confirm C3-C4 with a hot-crowd perf run before fixing.
Impact is at 1700 / 10k bots.

| # | Where | What is wrong (how often × size) | Impact | Fix (same behaviour, cheaper) |
|---|---|---|---|---|
| C1 | cold commit: `ColdSimulationOwner.commitBatch` → `persistencePatch` + `SavedStats.statsColumns`; `Database.writeColdCommitUnsafe`; triggers `bot_party_candidate_stats/_metadata` | every cold commit × ~10 KB: whole stats/mind/inventory stringified when only clock/vitals changed; json_patch + json_extract + 7 trigger json_extracts; ~10 KB row rewritten (~12-16 KB WAL, est. ~1.2 GB/h) | Med / **High** (the WAL growth) | changed top-level stats keys (`json_set` per key, as `writeHeldOnRevision`); skip inventorySummary when `bagChanged === false`; later move per-step fields out of statsJson |
| C3 | `Npc/Generics/BroadcastVitals` | every NPC HP change × all sessions: linear filter, 2 SpeckMath per session, packets built for bots and dropped; est. 20-50 ms/s at H=300 | Med / High | `World.realPlayerSessionsNear(loc, 3500)`, owner via `ActorQueries.byId` |
| C4 | `World.visibleUserSessions` realOnly (every `BotSession.dataSendToOthers`) | every bot packet × bots nearby: queries `kind: 'all'`, filters bots by name, sorts: O(H²) | Med / Med-High | query `kind: 'player'`; return before building a packet when nobody sees |
| C5 | `BotAfkMarketService.executePlan` → `MarketPricing.lineState` → `beliefFor` → `PriceBelief.prior` → `FirstPrice.priceOf` | every listed line in a cold review, on main: recomputes the belief only for `sigma` the worker already had (350-500 ms main turns measured) | Med-High (long turns) | carry `sigma` in the plan line; mind the 768 B plan cap |
| C6 | `MoveTo` bot branch | every visible hot bot move: all-session filter per move; non-companion routes run **sync** A* (2000 nodes) on main, up to twice | Med / Med-High | presence sessions; visible routes to the path pool (WOR-2) |
| C7 | `World.npc.spawns` reassigned by `filter` (SpoilSweep, NpcDied, NpcDecay, C4SkillEffects, PetMount, PetTravel) | every sweep / summon death × ~22k: a new array breaks `RaidEntityIndex` source → full rebuild on the next add or drop | Low-Med / Med | change in place; never reassign `spawns` |
| C8 | NPC grid 6000-unit cells (`fetchNpcsInRadius`) | aggro sweep 1/s per session incl. bots; BotStatus 3 s; hunting scans; ~25 callers: radius 300-2500 queries scan 18k×18k (100-749 NPCs), 9 key strings per call | Low-Med / Med | 2000-unit cells, radius-sized rings |
| C9 | linear `World.user.sessions` finds: `ClanService.onlineSessionByActorId` (roster display, assignments), NpcDied per kill, Attack clan buff/NPC AoE, EffectRestrictions fear, PartyAwareness | O(H) per commit / kill | Low / Med | `World.registeredActorById`, `ActorQueries.near/humans` |
| C9 | linear `World.user.sessions` finds: `ClanService.onlineSessionByActorId` per commit, NpcDied per kill, Attack clan buff/NPC AoE, EffectRestrictions fear | O(H) per commit / kill | Low / Med | `World.registeredActorById`, `ActorQueries.near/humans` |
| C10 | `HuntingState.claimedTargetIds` | every hot target scan × all sessions: O(H²) across hunters | Low-Med / Med | one claimed set per dispatcher turn (the function accepts `claimedIds`) |
| C11 | worker `flush` → `proposalSizes` → `JSON.stringify`; postMessage clone; main stringifies again (C1) | each state serialized ~3× on two threads; worker throughput is the binding limit | Low-Med / Med | estimate size from known parts; send stats/mind/inventory strings once |
| C12 | worker `EconomyContext` LRU 2048 (limits.md) | above 2048 bots each step becomes a full build (140-670 ms longest turns measured) | Low / **High** | size the LRU from the population or share by cohort; watch the 512 MB heap |
| C13 | packets for `BotSession` recipients dropped (statusUpdate per hit/regen, `userInfo` per EXP gain, `ConsoleText.transmit`) | buffer allocation for a no-op send | Low-Med / Med | guard with `session.botSession` or a lazy builder |
| C14 | per-actor timers: NPC combat `setInterval(100)`, `replenishVitals` `setInterval(3000)`, EffectTicker per effect, MoveTo chains | thousands of callbacks/closures per second | Low / Low-Med | one shared combat ticker, one regen ticker |
| C15 | `Npc` getters via `effectAdjusted` | every move step and combat tick: 2 full `statValues` passes per getter | Low / Low-Med | cache per NPC until the EffectStore revision changes |
| C16 | `Skillset.populate` → `fetchSkillFromSelfId` structuredClone | every activation: clones all levels, then drops them | Low / Low | clone base + used level |
| C17 | `LifeStateCache.set` → `removeOrder/insertOrder` | every state write: two O(N) splices | Low / Low | fine at 1700; bucketed list at 10k |

## Tests

1249 test files; CI run 41214661352 (2026-10-31, 12 shards): 4037 s of test time, 265-439 s per shard, slowest file
60 s (limit 180 s). About 78 % behaviour tests, 12 % mostly internals, ≈14 duplicate groups. Where each behaviour is
pinned instead was checked per file at the pass (not kept here).

| # | Where | What is wrong | Impact | Fix |
|---|---|---|---|---|
| TS1 | `test_skill_semantics.js` | asserts finish at 0.7 s, then 30 s idle on 3 ref'd timeouts (source not found) | 30 s CI | find and unref the timers |
| TS2 | test_static_gear_worker, test_gear_plan_memo, test_economy_basics_dependencies, test_craft_station_catalog, test_craft_material_party_events, test_bot_afk_listing_failure, test_market_lot_policy, test_n79_price_prior, test_spot_index, test_spot_matchup_memo, test_species_verdict_at_read, test_walkback_catalog_cache, test_quest_cure_fever_items, test_bot_tool_pending_audit, test_bot_wtb_recovery_floor, test_bot_wtb_cached_survival_floor, test_persona_party_copies, test_cold_message_pages, test_task4_arrival_step, test_pk_profiles; tests/fixtures/following_tick_pins.json, tests/helpers/sourceAssessmentReference.js (unused); dead-path one-liners in test_afk_trade_database ~205 (`matchAfkTradeShops`), test_bot_gear ~15 (`ensureCharacterGear`), test_bot_market_town_routing ~203, test_hot_board_review ~73, test_bot_economy_thresholds ~107 and test_bot_market_listing_policy ~72 (`listingFloor`), the E45 block of test_board_trip_suspects | internals pinned elsewhere or dead code | 20 files, ~65 s CI | first deletion batch (safe) |
| TS3 | test_clan_invite_priority (move 2 cases first), test_party_composition_topk_equivalence, test_clan_simulation_slice0, test_cold_store_release, test_cold_worker_pressure, test_meeting_survival_transport, test_spot_income_band_cache, test_cold_orphan_party_reconcile (keep its start-up half) | likely redundant | CI time | second batch, after a check; social graph tests go with PER-4, actor publication/grid tests with WOR-5, pk_* tests with POP-17 |
| TS4 | test_pvp_encounter_handoff (runs 4× per suite: spawned/required by expiry, extension, revenge_handoff); test_cold_ordinary_competition re-spawns test_cold_pvp and test_cold_competition_actions (~30 s) | whole-file re-runs | CI time | stop the re-runs |
| TS5 | the 8 `cold_*_admission` files (same preamble and matrix, 79 s CI); respawn 70 % HP pinned in 7 files; c4_* zone files (71 files, 193 s); profession route stubs (33 files, 203 s); test_cold_simulation_kernel and test_economy_context (most churn; mostly scheduler/cache mechanics) | duplication | CI time, churn | merge into behaviour / table-driven files; keep restart_point_revive (hot) and bot_background_respawn (cold) for respawn; trim the two big files |
| TS6 | known red in `notRunTests` (debt.md "Tests") | — | not run | fix: test_beginner_shot_policy (drop `usePolicy` asserts), test_cold_armor_set_effects (hard-coded castSpd), test_npc_purchase_consumers (l.118, counters l.74/86), test_task4_b5_hot_cold_same; trim: test_finite_market_income, test_gear_intermediate_candidates, test_task4_survival_tranche (keep part 1) |

## Game data against C4

Sources: Lisvus `gitlab.com/TheDnR/l2j-lisvus` @ fdc7e33 (the generators' pinned revision; datapack sql + stats xml),
L2J Mobius C4 @ 6bc10d28 (the spawn generator's pin), l2hub.info/c4. Where Mobius and Lisvus disagree, Lisvus is
taken as C4 unless l2hub says otherwise. Compared by script over the whole effective data (first row per id in
`DataCache` load order). Fact = compared value by value; guess = not traced to the end. Ordered by player impact.

| # | Where | What is wrong (ours / C4) | Impact | Fix |
|---|---|---|---|---|
| D-4 | active.json Mouth Odor Attack 4110 (NPC skill) `template.spell` | `spell: true`; Lisvus MDAM with no `isMagic` (not magic): magic damage, physical cast type | fact on the value, guess on effect. Our one flag also picks the damage formula (`Attack.prepareSkillDamage`, `ColdMobAction`), so `false` would turn its damage physical | code (debt.md 17), then data |
| D-5 | `data/Items/Others/others.json` (no generator) `etc.stackable` on 222 items | false on 200 quest and "Other" items (3444-3466 Black Lion Hunt goods, 4239-4312 quest items incl. 4259 Bear Skin, 4286; 4438/4439); true on 6 no-grade compressed shot packages (5134, 5140, 5146, 5250, 5256, 5262), the village SoEs 7554-7558 and quest items 990-1000; Lisvus `is_stackable` the opposite | fact on values. Q341 collects 20 Bear Skins = 20 bag slots; `Database` refuses a quest reward of more than 1 of a non-stackable (guess whether a quest hits it); bag weight/slot limits | data (hand file); check that the inventory compaction merges existing stacks in saves (guess) |
| D-8 | item stats (armors.json, weapons.json, others.json; no generators) | S/A jewelry M.Def low: Tateossian Earring/Ring/Necklace 63/42/85 (Lisvus 71/48/95), Majestic 60/40/80 (63/42/85), Phoenix 57/38/76 (60/40/80), Necklace of Mana 68 (72); Long Bow P.Atk 115 (114, l2hub agrees); canine pet Atk.Spd 277 (304), pet plates ±1; pet foods 2515/4038/5168 weight 40 (10); village SoE 7554-7558 weight 30 (0); spellbook prices 4916 800, 4906/4908 1250 (900); wines 5956-5958 (5000) | fact; small: high-grade mages' M.Def, one bow | data (hand files) |
| D-9 | `data/Npcs/npcs.json` templates not replaced by Lisvus (160 differ) | Ant 12004 (Queen Ant's Nest, 25 spawned): HP 847, passive, gives EXP; Lisvus HP 6861, aggro 500, EXP 0. The other 159 (Nurse/Royal Guard Ant, castle siege guards, town guards) are not spawned as monsters | fact; an easy, rewarding mob in a raid nest | data via the legacy generator (it takes `L2Monster`/`L2Minion` only) |
| D-10 | `data/Templates/class-vitals.json` (hand-made from Mobius master a4c31517, not the pinned 6bc10d28) | per-level HP/MP/CP: Human Fighter L19 HP 313 (before CON), mystic L19 405; Lisvus formula (`lvlHpAdd/Mod`) 356 / 445, up to 12 % more at levels 15-19, ~3 % in 1st class, ±1 % in 2nd. The Lisvus formula drops HP at a class change (356 at 19 → Warrior base 327 at 20); the Mobius table is continuous, so it looks like retail | fact on values, guess on which is retail; low-level survival, potions per hour | none unless l2hub shows per-level HP; say in combat.md "C4 check" that Mobius is used here and why |
| D-11 | skill cast ranges (`ColdCombatProfile` ~1479 reads them for cold reach) | Power Strike, Stun Attack, Frost Wall 50 vs 40; self/party skills with a range: Paagrio 1260/1261/1282/1305 400, songs/dances 40, Greater Group Heal 1219 600 (Lisvus none) | fact; cold reach | data |
| D-12 | new characters | miss the Tutorial Guide 5588 every Lisvus class gets | fact | starter items |
| D-13 | `generate-c4-legacy-drops` exclusions | 21 Lisvus drop rows of rewards.json monsters left out because the item has no template here: compressed C soulshot recipes 5154/5269 (recipes.csv has their recipes, but the scroll cannot be obtained), Zweihander 5284, spellbooks/amulets 5014/5015/6395-6398, grand boss jewels 6656/6660-6662 (Queen Ant, Core, Orfen, Antharas) | fact; unobtainable items | item templates (a generator), then drop the exclusions |
| D-14 | `generate-c4-legacy-drops` (rewrites the Lisvus-covered groups in rewards.json), `generate-c4-mobius-spawns` (strips rows from `data/Npcs/Spawns/spawns.json`) | generators write into hand files | a hand edit there can be lost or conflict on the next run | keep hand edits out of those files, or split them |

What this pass settled (do not re-check without a data change): item price, weight, grade, crystal count, soulshot
count and base stats of all 5722 item templates match C4 except D-5/D-8; so do the skill tree (13 143 rows), skill MP
(`scripts/check-skill-mp.js`), recipes.csv, extractable_items.csv, henna, the experience table, armor sets, 1977
monster templates, the reward rows of every generated `c4_*` slice and of the 560 rewards.json monsters Lisvus has
drops for, the knowledge base, "Strong Type" mobs (template × code multiplier, as Lisvus) and NPC shop prices (Lisvus
buylists × 1.15; C4 grocers sell no D+ shots). Also correct per Lisvus (game logic): Lucky to level 4, death EXP %,
overhit cap 25 %, party EXP bonus, `pkKillKarma`, mob EXP gap, `karmaLostForExperience`, static buyer cap, weight
penalty steps. Spawns stay as they are (maintainer, 2026-11-04): Lisvus spawns Wasp Worker 934, Talakin 756/757, Hatu
and Tanor monsters as minions only and has far fewer Immortal Plateau orcs than Mobius; not changed (old D-6/D-7).
Next pass targets (not checked): pets data, weapon SA and soul crystals (python generators), aggro ranges, per-mob NPC
skills, quest drop rates, manor, multisell, buff durations of ~47 skills against `C4SkillRules`, Mobius at the pinned
revision; the vendor trees (`tmp/vendor/l2j-lisvus`, `l2j-mobius`) are not on this laptop.
