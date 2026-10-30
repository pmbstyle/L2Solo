'use strict';
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const saved = { value: Table.value, best: Table.best, hunt: Hunt.huntIncome };
const timestamp = 1791758354013;
const inventory = {};
for (const entry of Gear.planFor({ classId: 48, level: 40 }).items) {
    const old = inventory[entry.selfId];
    inventory[entry.selfId] = { ...entry, amount: Number(old?.amount || 0) + 1,
        equipped: true, equippedCount: Number(old?.equippedCount || 0) + 1,
        equippedSlots: [...old?.equippedSlots || [], entry.slot] };
}
for (const [id, row] of Object.entries(inventory)) if (row.equippedSlots.includes(11)) delete inventory[id];
inventory[416] = { selfId: 416, amount: 1, slot: 11, equipped: true, equippedCount: 1, equippedSlots: [11] };
inventory[1464] = { selfId: 1464, amount: 10, stackable: true };
const state = { characterId: 990126, name: 'RefillBuyer', level: 56, phase: 'cold', activity: 'hunting',
    adena: 10000000, currentRegion: 'Giran', spotId: 'refill', inventory,
    stats: { classId: 48, playedHours: 20, visitEvery: [20, 4], wishFocus: ['power:420:11', 19, 700000] },
    loc: { locX: 81100, locY: 148000, locZ: -3466 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
const board = new BoardIndex();
board.put({ id: 1, ownerId: 990127, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 1, selfId: 1464, count: 2000, enchant: 0, price: 20 }] });
board.put({ id: 2, ownerId: 990128, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 2, selfId: 420, count: 1, enchant: 0, price: 700000 }] });
const row = shots => ({ exp: shots ? 1000000 : 500000, shots: 100, potions: 0, deaths: 0, stacks: 0 });
Table.value = (_id, _role, _level, shots) => row(shots);
// The shot benefit compares the best rows with and without shots (ShotStock.usePolicy).
Table.best = (_role, _level, shots) => row(shots);
Hunt.huntIncome = () => ({ perHour: 1000000, expPerHour: 1000000, spotId: 'refill' });
const deps = { timestamp, spots: [], board, npcOffersFor: () => [],
    routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]) };
try {
    assert(Progression.assess(state).required, 'the Tyrant still needs its C-grade legs');
    const before = Economy.forState(state, deps), stock = before.stock('shots');
    assert.equal(stock.survivalTarget, 100); assert.equal(stock.target, 400);
    assert.equal(before.network.focus[0], 'stock:shots');
    assert.equal(before.network.activity.amount, 390,
        'one available market lot fills the four-hour outing instead of only the missing survival tranche');
    const decision = invoke('GameServer/Bot/Population/ColdEconomyDecision').capture(before, state);
    const goal = invoke('GameServer/Bot/Goals/NeedsEvaluator').evaluate(state, { now: timestamp, errand: null,
        economy: { ...before, network: { ...before.network, activity: decision.activity } } })[0];
    assert.equal(goal.target.amount, 390, 'the larger native order survives worker transport and goal creation');
    for (const held of [100, 400]) {
        const filled = { ...state, inventory: { ...inventory, 1464: { ...inventory[1464], amount: held } },
            stats: { ...state.stats, ...before.statsPacket } };
        const after = Economy.forState(filled, deps);
        assert.equal(after.network.focus[0], 'power:420:11',
            'both a partial survival fill and a full outing restore the remembered Theca equipment goal');
        assert.notEqual(after.network.activity.rootKey, 'stock:shots');
    }
    console.log(`PASS outing shot purchase and return to Theca ${isMainThread ? 'main' : 'worker'}`);
} finally { Table.value = saved.value; Table.best = saved.best; Hunt.huntIncome = saved.hunt; }
if (isMainThread) {
    const worker = new Worker(__filename);
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => { if (code) process.exitCode = code; });
} else parentPort.postMessage('verified');
