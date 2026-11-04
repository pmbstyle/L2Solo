# Third pass: client entry points — crashes, accidental dupes/losses, bot economy (2026-11-03, t106dev)

Checked at 39e43408 (2026-11-04).

Scope: 87 request handlers, NpcTalkResponse + 46 NpcBypasses, Speak `.` commands, UserCommand. Deliberate cheating
for gain is out of scope (the admin panel is open to all by decision). Ordered by likelihood in normal play.
C = confirmed by reading the full path, P = probe, G = guess. Open rows only.

`Server.js` only catches what a handler returns; anything else reaches the process backstop (`NodeL2`: an unhandled
rejection is logged and counted, the server keeps going; an uncaught exception flushes `CharacterWriteQueue`, closes
the DB and exits 1; a half-done non-atomic move, PER-1/2/3, stays half done).

| # | Where | Normal-play trigger | Effect | Conf |
|---|---|---|---|---|
| X2 | `Backpack.dropItem` ~210 → `World.spawnItem` | drop a +N item, pick it up | comes back +0 (enchant not passed; PK drop passes it) | C |
| X3 | `NpcBypasses/GatekeeperTeleport` ~22 | double-click a destination | fee charged twice (no `pendingActorTeleport` check, adena taken before the delayed move) | C |
| X4 | `PurchaseItem.awardItem` ~30, `Bot/TradeService.giveItem` ~222 | buy 2 rings at an NPC / static merchant | one non-stackable row with amount 2; spreads into trades and bot inventories | C |
| X6 | `Speak.consume` ~267, `.tell/.invite/.joinparty` ~200, `BotManager.handlePlayerSpeak`, `BotRemoteChat.replyForStateNow`, `World.askForTeamUp` → `inviteBotByName` ~640, `RequestPledgePower`, `CrystallizeItem` | /tell a bot, party chat with LLM, invite a cold bot | a rejection in these unobserved chains reaches only the process backstop (logged once, counted); `inviteBotByName` throw leaks party capacity | C (missing catch), G (rejects) |
| X7 | buffered `deleteItem` vs direct awards (`useExtractableItem` ~517, `useRecipeItem` ~477, `QuestService.giveItem`, PER-1, PER-2) | any crash or stop between steps | award saved, consumption lost; half-moved NPC buy / merchant deal; logout during PER-1 100 ms steps = paid, nothing received | C |
| X8 | read → await → absolute write: `PurchaseItem.awardItem`, `SellJunk` ~93 (`.sell`, no NPC), `QuestService.giveItem/takeItem` vs buffered deletes and warehouse/enchant/pet transactions | `.sell` while companions loot; shots spent during pickup; deposit during a party adena split | one gain overwrites another: adena lost or created, memory ≠ DB | C pattern, G window |
| X9 | `Bot/TradeService`, TradeDone commit, `AfkTradeService.refreshActorInventory` ~530 | an item change while a bot trade commits | race: items can be duplicated; a used potion comes back in memory | C, G timing |
| X10 | ~25 quests (Q034 ~64, Q410, Q406, Q002, Q001) | turn-in while the stack changes / a write fails | several unchecked `takeItem`s then `giveItem`: reward without full cost | C |
| X11 | `Crystallize.js` (0x72) | crystallize +4 or higher | `fetchCristals()` instead of `C4EnchantRules.crystalCount`: too few crystals, two rules | C |
| X12 | `CharDelete` → `Database.deleteCharacter` | delete a clan leader | leaderless clan, stuck bot members, locked warehouse (C4 refuses) | C |
| X13 | `ClanWarehouse.withdraw` (transaction per line); `NpcBypasses/Clan.spendLevelCost` ~138 | multi-line withdraw; clan level-up while dead / pet-locked item | partial withdraw; SP lost and `clanLevelUpPending` stuck | C |
| X14 | `TradeService.buyFromStore` ~362 / `sellToStore` ~448 | static merchant deal | two writes; undo returns the item at +0; silent undo failure | C |
| X15 | `PrivateStoreBuy` ~16 (`count > 4`) | pick 5+ lines from an AFK shop (12 allowed) | refused with ActionFailed only; packages bought line by line can end half-sold | C |
| X16 | `Restart`, `Logout` vs `Session.error` | restart in a bot trade / with companions | no `BotTradeService.cleanup`, no `detachAll`; destroyed actor kept; companions carry to the next character | C path, G impact |
| X17 | `Select` ~193-247 | a throw in the click handler | catch treats it as "unknown object", sends `deleteOb` for a live target | C mech, G trigger |
| X18 | `buyFromLivePrivateStore`, `transferInventoryBetweenCharacters`, `afkTradeCreditAdenaUnsafe`, `TradeService.giveAdena` | rich seller | adena above 2^31-1 (only NPC sale caps), client shows negative | C |
| X19 | `NpcTalkResponse` `activeNpcTalk` never cleared; BuyShop, HennaRemove, NewbieBuff heal | link from an old dialog | stale dialog state: NPC services reachable away from the NPC; henna removal free (C4 charges) | C |
| X20 | `NpcTalkResponse` ~58 `invoke('…/NpcBypasses/' + name)` | crafted bypass name | the name is not checked against the bypass list, so a path outside `NpcBypasses/` can be loaded; the `html` bypass path is not normalised either | C/P crafted |
| X21 | `ValidatePosition` ~42 | crafted coordinates | accepted and persisted (note only) | C crafted |
| X23 | `CubicControl.summon` timers | disconnect with cubics | timers keep running on the destroyed actor | G |

Sound: bot trade (clamps, blocks equipped/quest items, repeated confirm joins the commit, DB re-check); live/AFK
private store and NPC sell are one transaction each; crafting (lock, DB re-check); multisell, MammonUnseal,
WeaponSA, Crystallization Station, DiamondExchange, SecondProfession; warehouse (counts, NPC within 300); enchant,
crystallize, pet transfer re-check in the transaction; pickup claimed atomically; CharSelected/CharDelete own account,
selection counter; RestartPoint synchronous; QuestAbort serialised; second login replaces the session; malformed
packets drop only the sender.

## Fixes in order

1. Handlers return their promises (Speak tell/party/LLM, askForTeamUp, PledgePower, CrystallizeItem).
2. One owner for every stack change (Backpack + InventoryMutationQueue, PER-3); relative SQL deltas in transactions
   (covers X7-X10).
3. Gatekeeper: refuse while `pendingActorTeleport`; fee inside the teleport commit.
4. NPC buy / static merchant onto the atomic methods (PER-1/2); one amount-1 row per non-stackable.
5. One ground-spawn helper keeping enchant and pet data.
6. Quests on `QuestStep.apply` (PER-3).
7. One crystal rule (`C4EnchantRules.crystalCount`).
8. Clan: refuse leader delete; batch clan withdraw; one transaction per clan level-up.
9. One `Session.leaveCharacter` (proposed) teardown for error, Restart and Logout.
10. Bypass allow-list, `html` path normalised, one interaction guard; one adena cap 2^31-1.
