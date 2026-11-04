# Persistence and long-lived systems

Checked at 39e43408 (2026-11-04).

Survey of t106dev @ 9f27b7fa (2026-11-03). Line numbers drift; search by name.
Scope: `src/Database*`, `src/History*`, journals, `Persistence/`, `database/sql`, saved games, Clan, ClanHall, Social,
Quest, Progression, class change, Items/Inventory/Warehouse, Knowledge, `data/` generators.

## Mechanisms

- **World DB** `src/Database.js` (11.4k lines, ~195 methods): one `node:sqlite` connection, WAL, every call through one
  promise queue (`enqueue`, `run`, `performTransaction`); its drain gives the event loop a turn after 12 ms of jobs,
  never inside one, so order and atomicity hold. Also holds game rules (clan join, AFK board, quest steps,
  NPC baskets, cold commits) — PER-10.
- **Schema:** `database/sql/sqlite.sql` re-run on every start + numbered migrations 1–83, then named ones (PER-5), in
  `applySchemaMigrations` (`schema_migrations`, `named_migrations`); some migrations live in modules
  (`PartyCandidateProjection`, `PlayerWarehouse`, `ClanRaidFailureMigration`, `BotClanConversationStore`,
  `DatabaseRecommendations`, `ClanWarRepository`, `ClanWarCombat`, `ClanJoinPenaltyMigration`).
- **Repositories** get injected internals and are merged onto `Database` (`ClanMembershipRepository`,
  `DatabasePlayerWarehouse`, `ClanLevelSpRepository`, `ClanWarRepository`, `DatabaseRecommendations`,
  `ClanAllianceRepository`, `ClanHall/Repository`, trade meetings).
- **Buffered hot writes** `Persistence/CharacterWriteQueue`: per-character field patches (exp, location, vitals, karma,
  item amount) flushed every 750 ms; `withCharacterFlush` flushes before any transactional method, and that method's own job
  first writes what was buffered while it waited in the queue (`CharacterWriteQueue.applyInJob`). One character's
  bad patch never holds back the others: a failed batch is written again per character; a bad value (TypeError,
  SQLITE_CONSTRAINT) drops that patch, any other fault puts it back for the next tick; each is counted (FailureLog).
- **History DB:** second file `<world>.history.sqlite`; world transactions write `history_outbox`, `HistoryWorker`
  moves rows, main deletes them; retention in `HistoryStore`.
- **Journals:** `EconomyJournal` (TEMP triggers sum adena/item flow), `PvpJournal`; one outbox row per flush.
- **WAL checkpoints:** `DatabaseCheckpointCoordinator` + worker (≥ 4 MB, every 5 s); the WAL truncate
  (`PopulationService.runAdaptiveWalReset`) is tried when a passive one finishes (`Database.onCheckpoint`, limits.md),
  during play too, budgeted at the last completed truncate's hold on main's DB queue; a skipped truncate leaves state
  retention its turn. It and state retention (`runStateRetention`, every
  `PersistentStateRetention` statement bounded by a LIMIT on an indexed range or a cursor that resumes next run) are
  admitted by `BackgroundWorkGovernor` (resource `db_maintenance`, refused with a player when the governor is off), their refusals counted in `Database.stats().maintenance.refusals` (`job:reason`, diagnostics off
  too), the truncate's last try in `checkpoint.lastResetAttempt`; both in the perf report. Not `NativeWriteCheckpoint` (a
  revision fence for bot rows).
- **Saved games:** `scripts/saved-games.js` (v2 = world + history file) via the launcher; `DatabaseRestore` installs
  with a marker and rolls back on next init; lock in `scripts/database-access.js`, which also checks a launcher
  update's DB paths and marks its migration phase in the update journal (`beginUpdateMigrations`). The perf window
  runs load a save into their own folder (`scripts/perf/window.js`), the save is never touched.
- **Workers:** none write the world DB. Cold bot worker sends proposals → `commitAndReleaseColdSimulationLeases`,
  `handoffColdSimulationToMain`. Clan planning worker gets snapshots.
- **Systems:** quests `Quest/QuestService` + 133 scripts → `QuestStep` → `applyQuestStep`; class change
  `ClassTransfer`, `SecondProfession` → `completeSecondProfession`, trees `ClassProgression`; warehouses
  `Warehouse/*`; clans `Clan/*` (69 files); `ClanHall/*`; `Social/*`; `Progression/*`; `Knowledge/*` (runtime);
  generated `data/KnowledgeBase/*.json`.

## Data flow

- **Hot:** cheap fields → `CharacterWriteQueue` → `characters`/`items`. Value-moving operations (warehouse, NPC sell,
  craft, enchant, SA, quest step, private store) → one transactional Database method under `withCharacterFlush`.
  Some still use row CRUD (`setItem`, `updateItemAmount`, `deleteItem`) — PER-1..3.
- **Cold:** `bot_life_state` row is authoritative (level, exp, sp, adena, location, vitals, `inventorySummary`,
  `statsJson`, `mindJson`, `simulationRevision`). A proposal names its revision; stale is refused. A commit also
  writes `characters` in the same transaction (only the moved columns); a resolve copies level, EXP, SP and vitals
  in one guarded UPDATE (`updateCharacterProgress`, nothing written when nothing moved). Items ↔ summary synced both ways;
  a cold commit reads and compares only the stacks its step moved (`InventorySummary.bagChange` `changedItemIds`) while
  the rows still match the stored summary (`bot_items_synced`, named migration `bot-items-synced`: a row per bot written
  by the commit at its `inventoryRevision`, deleted by an `items` trigger on any write of a row the sync reads, raw SQL
  too; a summary moved by another writer leaves it behind), else every stack. Every index on the row costs a WAL
  page per save (SQLite rewrites the entry of every column the UPDATE sets, changed or not), so no index holds
  `updatedAt` except the covering `bot_life_state_party_candidate_projection` (read with INDEXED BY), and the
  whole-row writers (`BotLifeState.save`, the cold commit) set the indexed `accountName`, `characterName`, `phase`,
  `partyId`, `nextResolveAt` only when the row does not hold the value (`HELD_ROW_COLUMNS`, read in the same job);
  `drop-unused-bot-life-indexes` dropped four that nothing read (42 MB/min, 14 % of the WAL).
  A save rewrites the whole row whenever its length moves (almost always), so the WAL per save is the row's size:
  the kit's skill records are saved as their ranks (`SavedSkills`: `[[selfId, level], ...]` when every record is
  its rank's data, else whole), written by `SavedStats.compact` and the kit rebuild, unpacked by
  `SavedStats.body`/`merge` and the raw kit readers (clan candidate trigger, buff seller check, clan member combat);
  a bag item whose name, kind and rank are its template's is saved without them (`InventorySummary.saved`, `t: 1`),
  every reader of the column takes `InventorySummary.read`.
- **History:** outbox in the same transaction → worker moves → main deletes; `readHistory` flushes first.
- **Schema evolution — five mechanisms:** re-run `sqlite.sql`; numbered then named migrations; `maintenance_tasks`
  one-shots; `world_meta` flags; service start-up migrations (`ClanService.migrateAutonomousClanNames`,
  `AfkTradeService.migrateBoardWorld`, `GiranShopDistribution`), plus `cleanZeroAmountItems` every init.
- **Migration numbers collided with upstream** (upstream's migration 67 "numbered after ours", "Early cooldown deployments
  occupied 81"; 74 and 75 run the same function; 83 repairs 81).

## Canonical owners

| Rule | Owner | Status |
|---|---|---|
| SQL access, queue, transactions | `Database.enqueue`, `inTransaction` | single owner |
| Hot field buffering | `CharacterWriteQueue` + `withCharacterFlush` | bypassed (PER-3) |
| Value-moving item operation | one transactional Database method per operation (`sellItemsToNpc`, `buyFromLivePrivateStore`, `applyQuestStep`) | half-migrated |
| Cold persisted state | `bot_life_state` + revision fence | owner |
| Saved row layout (kit ranks, bag items without template fields) | `SavedSkills`, `InventorySummary.saved`/`read` | owner |
| Join cooldown | `Clan/ClanRules.JOIN_COOLDOWN_MS` | shared |
| Clan-hall visit hot/cold | `ClanHall/VisitPolicy`, `VisitNeed` | shared |
| Death EXP | `Progression/DeathExperience` | shared |
| Karma wash | `Karma.karmaLostForExperience` | duplicated (PER-6) |
| Class eligibility | `ClassTransfer.eligibility` + `ClassProgression` | partly duplicated (PER-8) |
| History rows | `historyOutboxUnsafe` → `HistoryStore.APPLY` | owner |
| Stopped-DB integrity check | `DatabaseRestore.quickCheckDatabase` | shared |
| Generated data | each `scripts/generate-*`; KB checked by `check:knowledge-base` | no manifest (PER-14) |
| Generated KB in memory | `KnowledgeBaseService` `loadData`: one load per data directory, shared by `NativeKnowledgeBase` (NPC dialogs, bot dialogue) and the observer's pages (icons per request). In memory: manifest, skills, item/mob rows for lists and summaries (traits computed once), item sources as mob ids (`itemSourceIndex`), reward groups as one Float64Array (`rewardGroupIndex`): ~6 MB heap + 1 MB typed arrays. Full item/mob/spawn records are read on demand by byte range (`KnowledgeBaseRecords`: ranges scanned at load from the generator's layout, fds held open; the generator replaces files by rename) | owner |

## Debt

- **PER-1 player NPC buy is non-atomic** (`World/Generics/PurchaseItems`: adena via buffered `deleteItem`, items later
  in `setTimeout` steps). Bots use `purchaseNpcInventoryBasket`, player sell `sellItemsToNpc`. Canonical: the basket.
- **PER-2 player ↔ bot store trades in `Bot/TradeService`** take adena, give the item, refund by hand on failure, with
  direct row CRUD (`deductAdena`/`giveAdena`/`giveItem`). Atomic counterparts: `transferInventoryBetweenCharacters`,
  `buyFromLivePrivateStore`. Callers (`buyFromStore`/`sellToStore`/`sellInventoryToStore`): `Purchase`, `Sell`,
  `ShotStock`, `BotSupplyErrand`, `ShoppingState`.
- **PER-3 row CRUD beside transactions and the buffer.** `QuestService.giveItem/takeItem` (80 of 133 quests; ~50 use
  `QuestStep.apply` via `DeclarativeQuest`, ~9 both), `SellJunk`, `AdminGiveAdena`, `BotMammonUnseal`, `PetRuntime`, `CreateNewChar`.
  Inventory serialisation split three ways (`InventoryMutationQueue`, `questMutationTail`, `CharacterWriteQueue`).
- **PER-4 dead: social graph.** `Social/SocialGraphRepository`, `Database.ensureSocialEntity`/
  `commitSocialGraphEvent`, tables `social_entities/events/relations/projection_cursors`. Only a test uses it: a
  foundation never wired. Live memory is `InteractionMemory*`. **Decided 2026-11-03: delete code, drop the tables by
  a new migration, own change with review** (a named one, PER-5).
- **PER-5 five schema mechanisms**; `sqlite.sql` drifts from the migrated shape; tables created both there and in
  migrations. Fresh and upgraded DBs reach the final shape by different routes. **Decided 2026-11-03, agreed
  with Slava 2026-11-04:** new migrations are keyed by name, not number: `namedMigrations` in `applySchemaMigrations`,
  run after the numbered ones in list order, each recorded once in `named_migrations` (a name this build does not know
  is logged and kept). To add one, append `['what-it-does', () => …]`; numbered 1–83 stay. The first,
  `drop-unused-bot-life-indexes`, ran as numbered 84 on a few early worlds; it deletes that row. The launcher's
  schema guard knows both kinds (`launcher/docs/releases.md`). The other mechanisms
  (re-run `sqlite.sql`, `maintenance_tasks`, `world_meta` flags, service start-up migrations) move into that list over
  time.
- **PER-6 karma wash three copies** (`Karma.karmaWashForExperience`, `BotLifeState.prepareResolve`, SQL in
  `characterProgressStatement`, shared by `updateCharacterProgress` and the cold commit); karma stored in `characters.karma` and
  `statsJson.karma`. A death's wash is one rule (`DeathExperience.karmaLost`): hot via the death
  record, cold via the record's `karmaLost` in the cold commit; the `prepareResolve` persist path still recomputes
  `stats.karma` from gain only.
- **PER-7 character state in `characters` and `bot_life_state`** (level, exp, location, vitals; items vs summary),
  synced both ways; several EXP write paths. Which copy readers trust is unclear. A row left hot by a restart is
  rebuilt from the record at boot (`BotLifeState.staleHotRowFromRecord`); a hot row is not kept current during the
  session (POP-22). **Decided 2026-11-03:** `characters`+`items` are the character's record; `bot_life_state` is the
  worker's working copy; every write to either goes through one transaction that updates both (the two-way sync in the
  cold commit and after main's item moves is that, by design). Task: audit and close the one-copy writers (POP-5
  `writeColdRow` fallback, the EXP write paths, karma in two places + PER-6, `BotSupplyErrand.markCold`) and add a
  test that catches the copies diverging. After "make failures visible".
- **PER-8 class change parallel paths:** `ClassTransfer.transfer` (actor first, a failed rollback write only counted),
  `SecondProfession` → SQL with repeated checks, `BotClassProgression` and `GeneratedColdSeeder` call
  `updateCharacterClassId` with their own pick; `ClassProgression` `lineage`/`coldLineage` differ on purpose.
- **PER-9 two warehouse stores:** players `account_warehouse_items` (batch), bots per-character `warehouse_items`
  (line by line); clan warehouse player batch vs bot path; `transferPlayerInventoryToClanWarehouse` test only.
  **Decided 2026-11-03:** bots move to the account warehouse (`account_warehouse_items`, batch, atomic);
  `warehouse_items` goes by a named migration that moves its rows; own change with review, tested on a world copy.
- **PER-10 `Database.js` god module:** game rules inside; two access styles (~195 methods vs 148 raw
  `Database.execute` from 29 files); repositories half extracted; `ClanMembershipRepository` repairs bot goals;
  `ClanAllianceRepository` writes `character_quests`.
- **PER-11 repairs on every start hide unknown bugs:** `cleanZeroAmountItems` (`DELETE … amount <= 0`, silent),
  `migrateAutonomousClanNames`. `compact-stackable-inventory-v3` is called on every boot but is a `maintenance_tasks`
  one-shot (skipped once done; a new version name re-runs it).
- **PER-12 ephemeral-session opt-out checked at 15 call sites in 11 files** (`persistenceMode === 'ephemeral'`), not at the writer.
- **PER-13 duplicate script code:** `removeDatabaseFiles` in both `DatabaseRestore` and `saved-games`.
  (`market-store-*.sql` are live: migrations 43/44 and the outbox install read them.)
- **PER-14 generators without an output manifest:** ~50 `generate-c4-<zone>.js` slices still write npcs, rewards,
  skills, items; spawns now from `generate-c4-mobius-spawns.js`; three Python generators. Which `data/` file is
  generated cannot be told mechanically.
- **PER-15 two knowledge stacks:** runtime `Knowledge/*` vs generated `data/KnowledgeBase/*.json`; agree only after
  regeneration (`check:knowledge-base` is the guard).

## Open questions

1. Move player NPC buy and player ↔ bot-store trades to the atomic methods and remove `TradeService` buy/sell?
2. Social graph abandoned? Drop its tables by a migration? — decided 2026-11-03: yes (PER-4).
3. For a cold bot, which copy is the truth: `characters`/`items` or `bot_life_state`? Keep the two-way sync? —
   decided 2026-11-03 (PER-7).
4. Freeze `sqlite.sql`, all changes as numbered migrations, fold the other mechanisms in? How to avoid number
   collisions with upstream? — decided 2026-11-03: named migrations (PER-5).
5. Bots on the account warehouse too, or is the split intended? — decided 2026-11-03: account warehouse (PER-9).
6. Karma wash: with or without `MIN_KARMA_LOST`? One place for karma? (`MIN_KARMA_LOST` is 0, so "without"; the
   death wash is one rule; the copies of PER-6 stay.)
7. Port `giveItem`/`takeItem` quests to `QuestStep.apply`, or accept as legacy?
8. Start-time repairs still needed? What produced zero-amount rows and duplicate stacks?
