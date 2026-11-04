# World, movement, runtime loop

Checked at 39e43408 (2026-11-04).

Survey of t106dev @ 9f27b7fa (2026-11-03). Line numbers drift; search by name.
Scope: `World`, `Geodata`, `Network`, `Automation`, `Timer`, `EventLoopTurn`, `DataCache`, `WorldObserver`, `Server`,
`NodeL2`, `Global`, `Packet`, `AuthenticationServer`, town navigation, spots.

## Mechanisms

- **Boot** `src/NodeL2.js`: Global → DB lock → `Database.init` → `DataCache.init` → clan planning worker →
  `compactStackableInventory` → `ClanService.init` → `GeodataEngine.init` → `NpcInteractionGeometry.init` (a pack without verified counter geometry logs why, once) →
  `World.init` → runtimes (recommendations, clan hall) → `BotLifeState.init` (before the boot passes that write life
  rows) → AFK trade, personas, KB warmup → TCP servers →
  `BotManager.init` → `WorldObserver.init` → `DevConsole`. `World.init`: indexes, raid state, `spawnNpcs`, minions,
  grid, day/night, aggro ticker. Pathfinding pool starts lazily (first `request`). The perf recorder
  (`Perf/LiveRecorder`, `[Perf] live`) starts before any worker. Backstop: an unhandled rejection is counted by
  site, the first of each logged with its stack (`FailureLog`, the shared failure rule; status `swallowed=`); an uncaught exception, or any failure before startup finishes, flushes
  `CharacterWriteQueue`, closes the DB and exits 1. Shutdown (`NodeL2` `shutdown`): service drains capped at 10 s,
  then flush + close, forced exit by 16 s (limits.md).
- **Launcher** (`launcher/`, merged from develop): desktop server management, saves, preview releases; starts the
  server through `scripts/start.js` / `scripts/run-server.js` (SIGKILL 20 s / 18 s after a stop request);
  update startup checks the DB paths and marks migrations in its journal (`scripts/database-access.js`).
- **Globals** `src/Global.js`: `invoke`, `utils`, INI layering (default → `L2NODE_SHARED_CONFIG_FILE` → local.ini, or
  `L2NODE_CONFIG_FILE` instead of local), `path.*`. Also holds
  game data: `PEACE_ZONES` circles and `utils.isInPeaceZone`.
- **Network:** `Server.packetReceiver` splits the stream; `Packet/Frame` owns the unsigned 2-byte length both ways
  (game, login, bot sessions; over a frame: refused and counted); `Session.dataReceive` → `Network/Opcodes` →
  `Network/Request/*` (87); out `Packet/Send`, `Network/Response/*`. Auth separate. The packet trace names server packets by the
  `Network/Response/*` file that sends them (`Session` `SERVER_PACKET_NAMES`, kept in step by
  `tests/test_server_packet_names.js`).
- **World singleton** `World/World.js`: user sessions + `CharacterLocationIndex` (and a legacy `World.user.sessions`
  array), `npc.spawns`, NPC grid (6000), `NpcObjectIndex`, `RaidEntityIndex`, and party/invite/bot-chat logic that
  belongs to bots (WOR-15).
- **`World/WorldConstants`:** `CLIENT_VISIBILITY_RADIUS` 6000, `inClientView` ("the one rule of the view"). Worker-safe.
- **Geodata** `Geodata/GeodataEngine`: shared regions, `getHeight`, `hasLineOfSight`, A* `findPath`,
  `VirtualObstacles/*` per town.
- **Pathfinding pool** `Geodata/PathfindingWorkerPool` (≤ 2 workers) → `PathfindingWorker`. Callers: `MoveTo`
  (companions, long routes; town routes through the `TownNavigation.forPool` wrapper), NPC chase (`Npc.fetchCombatPathAsync`).
  A crashed worker is logged and respawned forever after the shared `WorkerRestartBackoff` (the cold worker's rule).
- **Movement — three engines (WOR-1):** players client-driven (`MoveToLocation` → broadcast; `ValidatePosition` →
  `UpdatePosition`); bots server-simulated `MoveTo.startPathMovement`; NPC/summon/pawn `Automation.scheduleAction`/
  `scheduleMoveToCoords`/`startMoveInterpolation`. Wander `NpcWander` is not its own engine: it drives
  `Automation.scheduleMoveToCoords` (and teleports home by `setLocXYZ`).
- **Town navigation (under Bot/AI, but world rules):** `TownPathfinder`, `TownTransitPolicy`, `TownNavigation`,
  `TownTraffic`, `TownNpcApproach` (`canInteract`), `TownNpcSlots`, `TownGateCatalog`, `BotTownTravel`,
  `CompanionTownTransit`.
- **Spots** `Bot/AI/SpotService`: `ensureIndexed` builds spots from `SpawnNpcs.catalogueSpawns(World)`; **without World
  (no `World.npc.definitions`) it returns `[]`** — in the worker that is an empty list, not an error.
- **Visibility:** packet side effects, not a known-list object. `Session.dataSendToMe` hooks (`CharacterVisibility`,
  `NpcVisibility`, `GroundItemVisibility`, clan war); area refresh `UpdateEnvironment` on ≥ 1000 moved. No DeleteObject
  when someone walks out of range.
- **Spawns:** `SpawnNpcs`, `RemoveNpc`, `NpcDecay`, `DayNightSpawnManager`, `RaidBossMinionManager`, `RaidBossState`.
- **Timers:** no central scheduler. `Timer.js` (reads Node internals `_idleStart`/`_idleTimeout`, used by Automation only), `EventLoopTurn`
  (setImmediate yield), tickers: `NpcAggro` 1 s (also drives wander), `EffectTicker`, `PopulationService` (6
  intervals), per-session `moveTimer`.
- **DataCache:** frozen datapack; two lookup styles (WOR-14).
- **WorldObserver:** dev HTTP UI (3.2k lines), reads World, DB, bots; own town list. Its knowledge pages read the
  game's one KB copy (`KnowledgeBaseService`, persistence.md).

## Data flow

- **Player move:** client 0x01 → `PlayerMoveDestination` (Z only) → `MoveTo` checks → broadcast. **No server path for
  players.** 0x48 `ValidatePosition` → `UpdatePosition`: set loc → `CharacterWriteQueue.location` →
  `updateEnvironment` → companions → replay stored actions. Every `setLoc*` updates the World index.
- **Bot move** (`MoveTo`): nearest real player by raw scan → low-LOD warp if nobody can see either end → town egress
  replay | worker path (companion or `maxNodes` > companion cap; a short LOS hop goes `short_direct`) | **sync
  main-thread `findPath`** (the rest) → fallbacks `TownPathfinder`, then straight LOS line, else no move. Segment loop on 100/250 ms with Z snap and `TownTraffic.steer`. Bots skip
  `updateEnvironment` while moving; their aggro comes from the 1 s ticker.
- **NPC chase:** worker path → `Automation.scheduleMoveToCoords` (linear, no Z snap) → `scheduleAction` approach.
  A request with no usable way (an empty path, one the target outran by 120, a pool error; `Npc` `pathFailed`, counted
  `noPath`) retries after 0.5/1/2/4 s; the mob keeps hating until the 2 min attack timeout drops that target (Lisvus).
- **Broadcast:** `dataSendToMeAndOthers` → `World.fetchVisibleRealPlayers` (index + `inClientView`); bots
  `BotSession.dataSendToOthers` (real sockets only).

## Canonical owners

| Rule | Owner |
|---|---|
| Is visible | `WorldConstants.inClientView` |
| Who is near | `World.fetchVisibleUsers/fetchVisibleRealPlayers/actorSessionsNear/nearestRealPlayer` |
| NPC by id / near a point / nearest of a template | `NpcObjectIndex.find` (`World.fetchNpc`) / `World.fetchNpcsInRadius` / `NpcObjectIndex.nearestOfTemplate` (town service targets) |
| NPC add/remove | `World.addNpcToGrid/removeNpcFromGrid` + `World.removeNpc` |
| Height, LOS, A* | `GeodataEngine`; off-thread `PathfindingWorkerPool` |
| Bot movement | `MoveTo` |
| NPC/summon approach | `Automation.scheduleAction` |
| Player position | `ValidatePosition` → `UpdatePosition` |
| Bot talk-to-NPC | `TownNpcApproach.canInteract` (player: `AttackRange.TALK_RANGE` 36) |
| Spawn/respawn | `SpawnNpcs` + `RemoveNpc` |
| Event-loop yield | `EventLoopTurn` |
| Process failure backstop, shutdown order | `src/NodeL2.js` (`shutdown`, `writeFinalState`; failures through `src/FailureLog.js`) |
| Is a bot | **none** (WOR-3) |
| Town identity | **none** (WOR-6) |

## Debt

- **WOR-1 three movement engines** (client, `MoveTo`, `Automation`; wander rides Automation). Z snap per step only in
  `MoveTo`; speed re-integrated only there, Automation uses a fixed `ticksToMove`; direct `setLocXYZ` in
  `NpcWander.teleportHome`, `SummonControl`, low-LOD warp. All share `session.moveTimer`, cleared with both
  `clearTimeout` and `clearInterval`. ~1800 lines (`Automation` 687, `MoveTo` 815, `NpcWander` 272). **Decided
  2026-11-03: one server-side engine for everything the server moves** (bots, NPC, summons, wanderers) on `MoveTo`
  with geodata and Z snap; `Automation` stays only as "approach and act" on top; players stay client-driven. Last of
  the large merges, own plan, measured with the perf tool. Small step first: separate the shared `session.moveTimer`.
- **WOR-2 sync vs worker A* for hot bots.** Only companions and long routes use the pool; the rest run `findPath` on
  main, twice on fallback. `Npc.fetchCombatPath` (sync) is test-only.
- **WOR-3 no single "is a bot" rule.** 17 local `isBot*Session` functions with different definitions, 122
  `startsWith('bot_')`, 24 `constructor(?).name === 'BotSession'` (21 files), `PlayerActivitySignal.isRealPlayerSession`
  (plus a local copy in `BotTradeService`), `NpcAggro.isHotBotSession`.
- **WOR-4 half-migration: spatial index vs raw `World.user.sessions` scans.** Always-true flags guard legacy branches
  (`World.actorSpatialIndex`, `World.botRealPlayerIndex`); `typeof World.fetchVisibleRealPlayers === 'function'`
  guards (`UpdateEnvironment`, `Cooldown`, `BotAI`, `BotBrain`, sessions); raw scans in `MoveTo`, `SpawnNpcs.notifyNearby`,
  `BroadcastVitals`, `NpcDied`, `Cooldown`, `Speak`, `AdminGiveAdena`, `fetchUser`/`fetchUserByName`.
- **WOR-5 dead: worker actor-publication pipeline:** `World/MainActorPublicationSource` (test/bench
  only), `notifyActorPublication`/`subscribeActorPublications`, `Population/ColdActorTableReceiver` (no importer),
  actor-read gates in `CharacterLocationIndex`/`CharacterActorSources`/`TableMirror`; the worker filters the `actors`
  table out. ~1000 lines. **Decided 2026-11-03: delete, as its own change with review** (map dead vs live branches first).
- **WOR-6 town identity in ≥ 6 tables:** peace-zone circles (`Global`), `TownRespawn.TOWNS`, `TownPathfinder.TOWNS`
  polygons, `ColdTrip.TOWN_RADIUS` 6000, `TravelRoutes.GATEKEEPER_TOWNS`, `ShopPlaces.PLAZAS`, WorldObserver list. "In
  town" is a circle, polygon or radius depending on the caller.
- **WOR-7 hot/cold travel time:** cold straight line / `RUN_SPEED` 120 in `ColdTrip` (`BotRoute`, `ClanWarMovement`
  call `ColdTrip.spotPlan`), hot geodata route × actor speed.
- **WOR-8 broadcast hooks copied 3×** (`Session.dataSendToMe`, `Session.dataSendToOthers`,
  `BotSession.dataSendToOthers`). Every visibility fix must touch three places.
- **WOR-9 NPC interaction distance in many places:** player 36, `TownNpcApproach` 72/300, `ShoppingState` 300,
  `ArenaDuelService` 250, `PrivateStoreTrade` 300. Only bots share one rule (`TownNpcApproach`).
- **WOR-10 per-location geodata fixes in three places:** `PlayerTransitionRecovery` (players), `VirtualObstacles`
  (everyone), `TownNpcSlots`/`TownGateCatalog` (bots).
- **WOR-11 direct `World.npc.spawns = …filter`** in 6 files (PetTravel, PetMount, C4SkillEffects, NpcDied, SpoilSweep,
  NpcDecay) bypassing `RemoveNpc`; full `npc.spawns` scans by selfId in ~9 files where `NpcObjectIndex` exists (`TownServiceCatalog` reads `nearestOfTemplate`).
- **WOR-12 action deferral three ways:** `Attack.queueEvent` (one slot), `actor.stored*` replayed in
  `UpdatePosition`, `Automation.playerAttackApproach`. Meets combat.
- **WOR-14 DataCache API split:** callback + structuredClone (`fetchItemFromSelfId`, 142 uses) vs
  `ItemTemplateIndex.find*` (~170 calls in 126 files) vs `npcRow`.
- **WOR-15 leftovers:** `Timer.js` reads private timer fields (the "TODO" is in `Automation.timer`); 7 inline
  setImmediate yields (`Database`, `ClanPlanningCoordinator`, two clan equipment services, `InteractionMemory`,
  `AfkTradeService`, `TradeMeetingService`) beside `EventLoopTurn`; opcode 0xff undefined (table has 255 slots: a 0xff packet throws); `UpdateEnvironment` comment wrong about
  hot bots; party/invite/bot-chat logic inside `World.js`.

## Open questions

1. Should NPC, summon and bot movement converge on one engine (MoveTo segment loop or Automation)? Players stay
   client-trusted (no server path check)? — decided 2026-11-03, see WOR-1.
2. All hot-bot A* through the pool, or sync for short routes on purpose?
3. Actor-publication pipeline (WOR-5): coming back, or delete with its tests? — decided 2026-11-03: delete (WOR-5).
4. Which "is a bot" predicate is the one?
5. Single owner of "town" (center, polygon, peace zone, respawn)? C4 uses zone polygons, not circles (guess).
6. Player talk range and bot `canInteract`: one rule?
7. Town navigation: move under `Geodata/`/`World/`, or stays bot-owned?
