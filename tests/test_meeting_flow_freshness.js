'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
process.env.L2NODE_PROGRESSION_RATE = 'x50';
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Market = require('../src/GameServer/Bot/Economy/MarketCounters');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const RecipeCodec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const MeetingCodec = require('../src/GameServer/AfkTrade/TradeMeetingCodec');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const { BoardIndex, recordOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const native = require('./helpers/workerEconomyDecision');

(async () => {
    const timestamp = Date.now(), recipe = Recipes.resolveByRecipeId(20);
    const state = { characterId: 910821, accountName: 'bot_flow_freshness', name: 'FlowBuyer',
        phase: 'cold', activity: 'shopping', level: 78, exp: Data.experience[77], adena: 100000000,
        currentRegion: 'Giran', homeRegion: 'Giran', loc: { locX: 83396, locY: 147904, locZ: -3400 },
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, timing: {},
        updatedAt: timestamp, simulation: { revision: 1 }, inventory: {},
        stats: { classId: 57, exp: Data.experience[77], money: [1000, .001, 0, 0],
            shotRecipeDemand: { itemId: recipe.recipeItemId, recipeId: 20, batches: 1, amount: 1, at: timestamp } } };
    for (const id of [20, 21, 22, 23, 24]) for (const row of Recipes.resolveByRecipeId(id).materials)
        state.inventory[row.selfId] = { selfId: row.selfId, amount: row.amount * 16, stackable: true };
    state.persona = invoke('GameServer/Bot/AI/BotPersona').generate(state);
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    for (let i = 0; i < 3; i++) state.stats.huntEfficiency = Hunt.record(state,
        { spotId: 'flow_test_hunt', cycleMs: 3600000, adena: 77000, exp: 100000, kills: 1, timestamp });
    Market.reset();
    // Peer deals price the D shot. Without them its belief is the craft first price, whose labour
    // reads the level-20 crafter's table hour: the T106 tables tripled it (a D shot above every
    // C-S shot), so the C-S crafts the new flow opens could not outrank the D recipe.
    for (let i = 0; i < 5; i++) Market.deal(1463, 140, 1000, timestamp - (20 - i) * 60000, 910823, 'Giran');
    Market.supplyDeal(1463, 10000, 'Giran', timestamp - 600000);
    Market.supplyDeal(1463, 10000, 'Giran', timestamp - 300000);
    let marketSource;
    Market.publish({ register: (_name, source) => marketSource = source, changed: () => {} });
    const boardRows = [[8001, [8001, 'sell_ad', 1, 910822, 'Giran', 1,
        [[9001, recipe.recipeItemId, 0, 3, 8000, null, 0]], 1, 1, 0]]];
    const input = () => ({ timestamp, nativeRoutes: true,
        recipes: { recipeBook: RecipeCodec.pack([21, 22, 23, 24]), knownShotRecipes: [21, 22, 23, 24] },
        tablePages: [{ tables: [
            { name: 'board', from: null, to: 0, full: true, rows: boardRows, removed: [], last: true },
            { name: 'market', from: null, to: 0, full: true,
                rows: marketSource.allRows().map(row => [row[0], row]), removed: [], last: true }
        ] }] });
    const baseline = await native(state, input());
    assert(baseline.tradeIntents.some(row => row.itemId === recipe.recipeItemId), 'D flow creates a finite recipe purchase');
    const funded = { ...state, stats: { ...state.stats, money: baseline.statsPacket.money,
        wishFocus: baseline.statsPacket.wishFocus } };
    const request = { token: 'flow-sensitive-recipe', actorA: state.characterId, actorB: 910822,
        seqA: 1, seqB: 1, town: 'Giran', point: state.loc,
        parties: [0, 1].map(() => ({ phase: 'cold', hotAt: 0, revision: 1, needRevision: 1, sequence: 1,
            route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })),
        lines: [{ payer: 0, itemId: 9000001, selfId: recipe.recipeItemId, count: 1, price: 8000,
            enchant: 0, adId: 8001, adRevision: 1, certificate: null }] };
    const oldInput = input(), priceRevision = Market.revisionOf('shot d');
    Market.supplyDeal(1463, 1000, 'Giran', timestamp - 1000);
    const duringMeetingMarket = marketSource.allRows().filter(row => ['h:1463', 'f:shot d'].includes(row[0]));
    assert.equal(Market.revisionOf('shot d'), priceRevision);
    const prepared = await native(funded, { ...oldInput, duringMeetingMarket, meetingRequest: structuredClone(request) });
    assert.equal(prepared.flowInjected, true, 'the update arrives after the native graph was built');
    assert.equal(prepared.flowInvalidated, true, 'the real market watcher retires in-flight consent on flow alone');
    const packed = MeetingCodec.fromPages(prepared.frames);
    assert.deepEqual(packed.dependencies, prepared.request.dependencies, 'flow revisions survive the bounded native transport');
    const board = new BoardIndex({ groupOf: Market.counterOf }); board.put(recordOf(boardRows[0][1]));
    const Life = invoke('GameServer/Bot/Population/BotLifeState'), Afk = invoke('GameServer/AfkTrade/AfkTradeService');
    const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const before = { cachedState: Life.cachedState, boardIndex: Afk.boardIndex };
    const host = { workerEpoch: 'flow-proof', worker: {}, stopping: false };
    const proof = { characterId: state.characterId, epoch: host.workerEpoch, worker: host.worker,
        authority: Commit.authority(funded), dependencies: packed.dependencies, sources: [[8001, 1]], token: request.token };
    try {
        Life.cachedState = id => id === state.characterId ? funded : null;
        Afk.boardIndex = () => board;
        const current = () => Coordinator.meetingPreparationCurrent.call(host, proof, request);
        assert.equal(current(), true, 'the real worker proof initially agrees with main');
        const peerRevision = Market.revisionOf('shot c');
        // No state, board, peer-price, wallet or recipe-book changes.
        for (const id of [1464, 1465, 1466, 1467]) {
            Market.supplyDeal(id, 100000, 'Giran', timestamp - 2000);
            Market.supplyDeal(id, 100000, 'Giran', timestamp - 1000);
        }
        assert.equal(Market.revisionOf('shot c'), peerRevision, 'configured purchases leave peer counters unchanged');
        assert.equal(current(), false, 'new flow invalidates old meeting consent on main');
        const fresh = await native(funded, input());
        assert(fresh.tradeIntents.some(row => row.itemId === recipe.recipeItemId),
            'the finite production setup remains useful after other grades gain demand');
        const renewed = await native(funded, { ...input(), meetingRequest: structuredClone(request) });
        assert.notDeepEqual(renewed.request.dependencies, proof.dependencies,
            'renewed consent must capture the changed flow instead of reusing the stale proof');
    } finally { Life.cachedState = before.cachedState; Afk.boardIndex = before.boardIndex; Market.reset(); }
    console.log('PASS native flow change, scoped dependencies, transport, stale-proof refusal and renewed consent');
})().catch(error => { console.error(error.stack, error.meetingTrace); process.exitCode = 1; });
