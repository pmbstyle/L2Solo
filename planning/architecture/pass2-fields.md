# Second pass: fields written but never read, or read but never written (2026-11-03, t106dev)

Checked at 516f6ef9 (2026-11-03).

Indexed with acorn over `src/` of the main checkout (t106dev). Paths relative to `src/GameServer/`.

## Bugs it reveals (top)

| # | Finding | Where | Effect |
|---|---|---|---|
| F1 | Bots never start the soul crystal quest (Q350): the only producer of `kind:'crystal_quest'` went with 82e5323c (2026-10-09) | `BotImprovementPolicy` ~202; dead: `Database` ~8305-8340, `BotImprovementService` ~119, `ColdSoulCrystal` | only bots with an old Q350 row progress |
| F2 | A hot bot in combat counts as available for a trade meeting: `state.fetchAttacks()` does not exist (State has `fetchHits`) | `Database.tradeMeetingPositionUnsafe` ~11317 | meetings with fighting bots |
| F3 | Buffer "busy" ignores movement: `state.fetchMoves()` does not exist | `BuffService` ~46, ~334 | moving buffer/buyer never refused |
| F4 | Clan-equipment parties not recognised as operations: reads `stats.clanOperation`, written only as `stats.objective.clanOperation` | `PlayerPartyTakeover` ~78 vs `ClanEquipmentService` ~171 | player may take over such parties (likely) |
| F5 | Cold clan-hall visit reads `stats.clanAllianceQuest`, which exists only on the hot session | `ClanHall/VisitPolicy` ~31 | alliance duty ignored cold (if possible cold) |
| F6 | Mercenary tickets do nothing but report success: `session.tryPlaceMercTicket` / `mercTicketManager` never set | `Actor/Backpack` ~449 | silent no-op |
| F7 | `options.hasWarehouseWorkflow` never passed: the `warehouse_state` refusal never fires | `ColdSimulationOwner` ~31 | guard dead |
| F8 | Tables written, never read or pruned: `bot_negotiations`, `clan_hall_events` | `BotNegotiationService` ~191, `ClanHall/Repository` | grow forever |
| F9 | Worker ↔ main sanity data ignored: `ready.data` catalog sizes, `init.catalogVersion`, envelope `sentAt` | Worker ~2187, Coordinator ~752, Protocol ~154 | mismatched catalogs undetected; no latency |
| F10 | `stats.pvpIntent` never written: the `risky` ×0.5 loss-hours never applies | `BotHuntEfficiency` ~149 | risk misjudged |
| F11 | `goal.plan.personaDrive` writer removed (d4322a21) | `BotManager` ~242, `NativeStatus` ~66 | "wealth" label never shown |

## Write-only (cost bytes on every commit, nobody reads)

- Cold `stats`: `lastConsumablePurchase`, `lastExperienceAward`, `lastMarketPurchase`, `lastImprovement`,
  `lastClanContribution`, `lastClanWarehouseTransfer`, `lastWarehouseDeposit`, `lastRaidPreparation`, `lastRespawnAt`,
  `lastResurrectAt`, `legacyShoppingRecoveredAt`, `partyIncomeDecision`, `coldCompetition.endedAt`, `spiritshotCost`,
  `soloSafe`, `plannedForGrade`, goal `requiredAdena`; WorldObserver-only: `expEarned`, `spEarned`, `adenaEarned`,
  `lastResolveDebug`.
- Party `statsJson`: `memberNames`, `lastRecruitAt`, `lastResolveAt`, `dissolvedAt`, `dissolvedReason`,
  `replacedForClan`, `declaredMemberCount`, `attachedMemberCount`, `personaFormation`, `lastPartyMarketBreak`.
- Hot session: `preShopLocation` (10 writers; reader removed on purpose in 648e3129), `targetAcquiredAt`,
  `pendingBrainTurn` (code uses `pendingBrainTurns`), breadcrumbs `lastEquipmentUpgradeAt`, `lastTownTravelFailure`,
  `lastHotPolicyReset`, `lastBrainBudget`, `lastBrainDecision`, `lastRevengeDecision`, `lastFinisherDecision`,
  `lastAmbientScene`, `chatArrivalReason`, `lastSkillOutcome`, `combatOutcomeCounts`, `lastConflictParticipation`,
  `lastWalResetResult`.
- DB columns: `afk_trade_shops.closedAt` (dead), `afk_trade_lines.initialCount`, `clan_operation_members.reservedAt/
  releasedAt`, `board_trade_meeting_lines.sourceAdRevision`, clan goal `orderRevision` (maybe meant for stale checks).

## Read but never written (harmless fallbacks)

`stats.clanEquipmentOrder`, `stats.craftService`, `stats.routeRole`, `stats.pkKills`, `session.botTrade` (redundant
guard in 7 item services), `session.partyRole` / `isSimPlayer` / `simPlayer`, `session.workerCommand` (diagnostic),
`offer.onceReward` (dead quest option); table `clan_hall_startup_schedule` read, written only by tests (operator hook?).
