'use strict';
// Survival first: a D fighter saving for a C weapon it cannot pay yet, with no D soulshot
// in its bag, buys its shots first when its kit reserve holds their refill. Before, the
// money queue ranked the shots by value per adena behind the weapon, stopped at the
// weapon it could not pay, gave the shots no funded row and the bot hunted for the
// weapon without them; a poorer bot's wake for the shots waited for the weapon's money.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
require('./helpers/progressionRate').useRate('x50');
const Data = invoke('GameServer/DataCache'); Data.init({ validate: false });
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Pricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const Situations = invoke('GameServer/Bot/Situations');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Packet = require('../src/GameServer/Bot/Economy/StatsPacket');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const D_SOULSHOT = 1463, POLEAXE = 95, POLEAXE_ASK = 2000000;
const timestamp = 1795270306000;
// A level 40 fighter in D gear, no D soulshots in the bag: the C weapon is next.
const inventory = {};
for (const entry of Gear.planFor({ classId: 1, level: 36 }).items) {
    const old = inventory[entry.selfId];
    inventory[entry.selfId] = { ...entry, amount: Number(old?.amount || 0) + 1,
        equipped: true, equippedCount: Number(old?.equippedCount || 0) + 1,
        equippedSlots: [...old?.equippedSlots || [], entry.slot] };
}
inventory[736] = { selfId: 736, amount: 1, stackable: true };
const fighter = adena => ({ characterId: 990241, name: 'ShotsFirst', level: 40, phase: 'cold', activity: 'hunting',
    adena, currentRegion: 'Gludio', spotId: 'dshots', inventory,
    stats: { classId: 1, role: 'dps', playedHours: 20, exp: Data.experience[39] + 1 },
    loc: { locX: -12736, locY: 122816, locZ: -3112 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } });
// In Gludio a crafter lists D soulshots at the ask ceiling and a seller the C Poleaxe.
const board = new BoardIndex();
board.put({ id: 1, ownerId: 990242, storeType: 1, kind: 'sell_ad', town: 'Gludio',
    lines: [{ lineId: 1, selfId: D_SOULSHOT, count: 20000, enchant: 0, price: 70 }] });
board.put({ id: 2, ownerId: 990243, storeType: 1, kind: 'sell_ad', town: 'Gludio',
    lines: [{ lineId: 2, selfId: POLEAXE, count: 1, enchant: 0, price: POLEAXE_ASK }] });
const saved = { value: Table.value, best: Table.best, hunt: Hunt.huntIncome };
const row = shots => ({ exp: shots ? 2000000 : 1000000, shots: 2000, adena: 3000000, potions: 0, deaths: 0, stacks: 20 });
Table.value = (_id, _role, _level, shots) => row(shots);
Table.best = (_role, _level, shots) => row(shots);
Hunt.huntIncome = () => ({ perHour: 3000000, moneyPerHour: 3000000, expPerHour: 2000000, spotId: 'dshots' });
Pricing.useBoard(() => board);
const deps = () => ({ timestamp, spots: [], board, npcOffersFor: () => [], caller: 'step',
    routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]) });
const queued = (economy, key) => economy.network.queue.find(wish => wish.key === key);
const shotRow = economy => {
    const money = economy.statsPacket.money;
    return [...Array(Packet.fundedRows(money)).keys()].some(at => Packet.fundedItem(money, at) === D_SOULSHOT);
};
const shotStop = step => step?.rootKey === 'stock:shots' && Number(step.itemId) === D_SOULSHOT && step.town === 'Gludio';
try {
    // The reserve holds the refill; the weapon is beyond the wallet.
    const wallet = 600000;
    let economy = Economy.forState(fighter(wallet), deps());
    const refill = queued(economy, 'stock:shots').price;
    assert.equal(economy.stock('shots').current, 0, 'fixture: no D soulshot in the bag');
    assert.equal(economy.kitCost(D_SOULSHOT), refill, 'fixture: the reserve holds the whole refill');
    assert(refill <= wallet && wallet < economy.refillReserve + POLEAXE_ASK, 'fixture: the wallet pays the refill, not the weapon');
    const weapon = queued(economy, `power:${POLEAXE}:14`);
    assert(weapon && !weapon.funded, 'fixture: the bot saves for the C weapon');
    assert(queued(economy, 'stock:shots').funded, 'the shots its reserve holds are funded, though the weapon before them is not');
    assert(shotRow(economy), 'the money packet has a funded D soulshot row');
    assert(shotStop(economy.network.activity), `the bot goes to buy its shots first (${economy.network.activity?.key})`);

    // A poorer bot: the wallet does not hold the refill yet. It hunts for the weapon, and
    // the money its build waits for is the shots' refill, not the weapon's.
    Economy.forget(990241);
    economy = Economy.forState(fighter(100000), deps());
    assert(!queued(economy, 'stock:shots').funded, 'fixture: 100k does not pay the refill');
    assert(!shotStop(economy.network.activity), 'fixture: without the refill money the bot hunts');
    const armed = economy.statsPacket.wishSections.affordAt;
    assert.equal(armed?.at, refill, 'the wallet the build waits for is the shots\' refill, not the weapon ahead of them');
    const before = { ...fighter(100000), stats: { ...fighter(100000).stats, wishFocus: economy.statsPacket.wishFocus,
        dormantWishes: economy.statsPacket.dormantWishes, decisionSeq: economy.statsPacket.decisionSeq,
        activityLeaf: economy.statsPacket.activityLeaf, money: economy.statsPacket.money,
        wishSections: economy.statsPacket.wishSections } };
    const after = { ...before, adena: Math.ceil(armed.at) };
    assert(Situations.detect(before, after).includes('goal_affordable:focus'), 'the wallet reaching it is a situation');
    // The build it wakes holds the hunting step; the shots take it over.
    economy = Economy.forState(after, deps());
    assert(shotRow(economy), 'the woken build funds the D soulshots');
    assert(shotStop(economy.network.activity), `the woken build sends the bot for its shots, not on hunting (${economy.network.activity?.key})`);
    console.log('PASS a D fighter saving for a C weapon buys the shots its reserve holds first; a poorer one is woken at their refill');
} finally {
    Table.value = saved.value; Table.best = saved.best; Hunt.huntIncome = saved.hunt; Pricing.useBoard(null);
}
