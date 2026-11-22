'use strict';
// A bot's price of a graded shot is what it pays for it: the board's cheapest
// ask, at most the crafters' ask ceiling. Old cheap deals (an x1 world's D
// soulshots at 10) are no price a bot can buy at: a D bot priced its refill
// at them, its kit reserve held a tenth of the refill and its money packet
// never funded the shots it then could not buy. Main and the worker alike.
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
require('./helpers/databaseIsolation');
require('../src/Global');
require('./helpers/progressionRate').useRate('x50');
const Data = invoke('GameServer/DataCache'); Data.init({ validate: false });
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Pricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Packet = require('../src/GameServer/Bot/Economy/StatsPacket');
const CrafterStock = require('../src/GameServer/Bot/Economy/CrafterStock');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const D_SOULSHOT = 1463;
const saved = { value: Table.value, best: Table.best, hunt: Hunt.huntIncome };
const timestamp = 1795270306000;
// A level 28 fighter in its D gear (the plan's set), no D soulshots in the bag.
const inventory = {};
for (const entry of Gear.planFor({ classId: 1, level: 28 }).items) {
    const old = inventory[entry.selfId];
    inventory[entry.selfId] = { ...entry, amount: Number(old?.amount || 0) + 1,
        equipped: true, equippedCount: Number(old?.equippedCount || 0) + 1,
        equippedSlots: [...old?.equippedSlots || [], entry.slot] };
}
inventory[736] = { selfId: 736, amount: 1, stackable: true };
const state = { characterId: 990231, name: 'DShotBuyer', level: 28, phase: 'cold', activity: 'hunting',
    adena: 600000, currentRegion: 'Gludio', spotId: 'dshots', inventory,
    stats: { classId: 1, role: 'dps', playedHours: 20 },
    loc: { locX: -12736, locY: 122816, locZ: -3112 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
const board = new BoardIndex();
const ceiling = CrafterStock.shotCeiling(D_SOULSHOT);
const crafterLine = price => board.put({ id: 1, ownerId: 990232, storeType: 1, kind: 'sell_ad', town: 'Gludio', revision: price,
    lines: [{ lineId: 1, selfId: D_SOULSHOT, count: 20000, enchant: 0, price }] });
// Shots double the hour's exp; 2,000 an hour at a 3M hour: a shot is worth ~0.5 h per 1000.
const row = shots => ({ exp: shots ? 2000000 : 1000000, shots: 2000, potions: 0, deaths: 0, stacks: 20 });
Table.value = (_id, _role, _level, shots) => row(shots);
Table.best = (_role, _level, shots) => row(shots);
Hunt.huntIncome = () => ({ perHour: 3000000, expPerHour: 2000000, spotId: 'dshots' });
const deps = () => ({ timestamp, spots: [], board, npcOffersFor: () => [],
    routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]) });
Pricing.useBoard(() => board);
try {
    assert.equal(ceiling, invoke('GameServer/Bot/Economy/PriceAnchor').shotAnchor(D_SOULSHOT), 'the crafters ask at most the D soulshot\'s anchor');
    assert(ceiling > 60, `x50: the anchor ${ceiling} is far above the old x1 deals at 10`);
    // The world's old deals: D soulshots sold at 10 when stores sold them at x1.
    for (let i = 0; i < 20; i++) Counters.deal(D_SOULSHOT, 10, 1000, timestamp - 3600000 + i, 990233, 'Gludio', 990234);
    crafterLine(ceiling);
    const economy = Economy.forState(state, deps()), stock = economy.stock('shots');
    assert.equal(stock.itemId, D_SOULSHOT, 'the D weapon fires D soulshots');
    assert(stock.survivalMissing > 0, 'no D soulshot in the bag: the refill is missing');
    assert.equal(stock.unitPrice, ceiling, 'the refill is priced at the crafters\' ask, not at the old deals');
    assert.equal(economy.kitCost(D_SOULSHOT), stock.refill * ceiling, 'the reserve holds the whole refill at that ask');
    const money = economy.statsPacket.money, rows = Packet.fundedRows(money);
    const shotRow = [...Array(rows).keys()].find(at => Packet.fundedItem(money, at) === D_SOULSHOT);
    assert.notEqual(shotRow, undefined, `the money packet funds the D soulshots (${JSON.stringify(money)})`);
    assert.equal(economy.network.activity?.rootKey, 'stock:shots', 'the bot goes to buy its shots');
    // A cheaper ask on the board is the price the bot pays (another bot's first build).
    crafterLine(60);
    assert.equal(Economy.forState({ ...state, characterId: 990235 }, deps()).stock('shots').unitPrice, 60,
        'the board\'s cheaper ask is the price');
    console.log(`PASS a D bot prices, reserves and funds its D soulshots at the crafters' ask ${isMainThread ? 'main' : 'worker'}`);
} finally {
    Table.value = saved.value; Table.best = saved.best; Hunt.huntIncome = saved.hunt; Pricing.useBoard(null); Counters.reset();
}
if (isMainThread) {
    const worker = new Worker(__filename);
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => { if (code) process.exitCode = code; });
} else parentPort.postMessage('verified');
