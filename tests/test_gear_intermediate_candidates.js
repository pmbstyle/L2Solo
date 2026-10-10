'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('gear-intermediate');
require('../src/Global');
fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'); Data.init();
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const board = new BoardIndex();
const trip = town => town === 'Dion' ? 0 : Infinity;
trip.details = town => ({ known: town === 'Dion', hours: 0, fees: 0 });
const state = { characterId: 910, name: 'IntermediateArcher', accountName: 'bot_910',
    phase: 'cold', activity: 'hunting', level: 45, adena: 3000000, currentRegion: 'Dion',
    loc: { locX: 19223, locY: 146228, locZ: -3069 }, timing: {},
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
    stats: { classId: 9, exp: Data.experience[44] + 1, generatedCold: true,
        persona: { primaryDrive: 'progression', understanding: 1, traits: { ambition: 0, commitment: 0,
            caution: .5, resilience: .5, assertiveness: .5, empathy: .5, sociability: .5 } } },
    inventory: { 1835: { selfId: 1835, amount: 1000000 } } };
// Control fixture holdings, not the chosen wish: other slots already have a
// current-grade kit, while the real archer carries a working NG bow.
for (const [slot, rows] of Providers.gearCandidates(state)) {
    if ([7, 14].includes(slot)) continue;
    const item = rows[0]; if (!item) continue;
    state.inventory[item.selfId] = { selfId: item.selfId, amount: 1, slot, equipped: true, equippedCount: 1 };
}
state.inventory[13] = { selfId: 13, amount: 1, slot: 14, equipped: true, equippedCount: 1 };
assert(Planner.combatReadiness(state).hasWeapon, 'this is not the emergency unarmed bridge');
const deps = { spots: [], board, tripCost: trip, knowledgeEnabled: false,
    npcOffersFor: id => Market.npcOffers(id, 'Dion'), timestamp: 1791464400000 };
let context, original;
for (let seq = 1; seq <= 50; seq++) {
    original = { ...state, stats: { ...state.stats, decisionSeq: seq } };
    context = Economy.forState(original, deps);
    if (context.network.activity?.activity === 'shopping' && context.network.activity?.rootKey.startsWith('power:')) break;
}
assert.equal(context.network.activity?.activity, 'shopping');
const activeWish = context.network.queue.find(row => row.key === context.network.activity.rootKey);
assert(activeWish?.object?.slot, 'actual common network selected gear, not a supplied activity');
const item = Data.items.find(row => row.selfId === activeWish.object.itemId);
assert(['none', 'd'].includes(item.etc.rank), 'a useful available intermediate competes despite current C grade');
assert(context.network.queue.some(row => row.key === activeWish.key && row.funded));
const shortlist = Providers.gearCandidates(original, context);
for (const rows of shortlist.values()) assert(rows.length <= Providers.GEAR_FINALISTS_PER_SLOT);
const weapons = [...shortlist].flatMap(([slot, rows]) => [7, 14].includes(slot) ? rows : []);
assert(weapons.some(row => row.etc.rank === 'd'), 'D remains in the economic comparison even with a wallet covering some C');
assert(weapons.some(row => row.etc.rank === 'c'), 'C remains an alternative, no forced D ladder');
assert(!weapons.some(row => ['b', 'a', 's'].includes(row.etc.rank)), 'game grade limit stays authoritative');
const exactOptions = { wishTargetId: item.selfId, findMarketOffer: target =>
    Market.npcOffers(target.selfId, 'Dion').sort((a, b) => a.price - b.price)[0], findNpcOffer: target =>
    Market.npcOffers(target.selfId, 'Dion').sort((a, b) => a.price - b.price)[0] };
const selected = Selection.selectAcquisitionPlan(original, null, { spots: [], timestamp: deps.timestamp,
    preparedEconomy: context, planningOptions: exactOptions }).acquisitionPlan;
assert.equal(selected.target.selfId, item.selfId, 'native planner keeps exact lower-grade wish target');
assert.equal(selected.strategy, 'market');
assert.equal(selected.market.sourceType, 'npc');
assert.equal(Planner.marketPlanForTarget(original, item.selfId, exactOptions).target.selfId, item.selfId);
const tooHigh = Data.items.find(row => row.etc?.rank === 'b' && Planner.suitable(row, original, Planner.roleFor(original), 'b'));
assert(tooHigh && !Planner.considerable(tooHigh, original));
const held = { ...original, stats: { ...original.stats, equipmentPlan: { target: { selfId: item.selfId } } } };
assert([...Providers.gearCandidates(held, context).values()].some(rows => rows.some(row => row.selfId === item.selfId)));
assert.equal(Economy.forState(original, deps), context, 'same event reuses result and held roll');
// Multiple professions/level bands use the same shortlist owner; an
// incompatible or over-level item cannot turn its proxy into a purchase.
for (const classId of [9, 12, 5, 2, 55]) for (const level of [25, 45, 55]) {
    const actor = { ...state, level, inventory: {}, stats: { ...state.stats, classId } };
    const view = Providers.gearCandidates(actor);
    const nativeRole = Planner.roleFor(actor);
    const ng = [...view.values()].flat().filter(row => [7, 14].includes(Number(row.etc.slot)) && row.etc.rank === 'none')
        .sort((a, b) => Planner.itemScore(a, nativeRole, classId) - Planner.itemScore(b, nativeRole, classId))[0];
    if (ng) actor.inventory[ng.selfId] = { selfId: ng.selfId, amount: 1, equipped: true, equippedCount: 1, slot: ng.etc.slot };
    const priceView = { survivalReserve: 1000, price: id => Number(Data.items.find(row => row.selfId === id)?.template.price || 0) };
    const picks = [...Providers.gearCandidates(actor, priceView).values()].flat();
    assert(picks.length <= 14 * Providers.GEAR_FINALISTS_PER_SLOT);
    assert(picks.every(row => Planner.considerable(row, actor)));
    if (ng && [...view.values()].flat().some(row => [7, 14].includes(Number(row.etc.slot)) && row.etc.rank === 'd'
        && Planner.itemScore(row, nativeRole, classId) > Planner.itemScore(ng, nativeRole, classId))) {
        assert(picks.some(row => [7, 14].includes(Number(row.etc.slot)) && row.etc.rank === 'd'),
            `class ${classId} level ${level}: useful D is an alternative before execution`);
    }
}

// Real current quote, not only a catalogue forecast, changes the final slot
// winner while the desired C alternatives remain in the immutable index.
const d = weapons.find(row => row.etc.rank === 'd');
const c = weapons.find(row => row.etc.rank === 'c');
const ctx = { ...context, price: id => id === c.selfId ? 1 : context.price(id),
    persona: { ...context.persona, traits: { ...context.persona.traits, ambition: 0 } } };
board.put({ id: 1, ownerId: 999, storeType: 1, kind: 'sell_ad', town: 'Dion', revision: 1,
    lines: [{ lineId: 1, selfId: c.selfId, count: 1, price: 1 }] });
const cheapC = Providers.build(original, ctx, { ...deps, board });
assert(cheapC.nodes.some(row => row.need === 'power' && row.object?.itemId === c.selfId),
    'a current cheap C offer can beat the intermediate; grade is not the order');
const gearRoots = cheapC.nodes.filter(row => row.key.startsWith('power:'));
assert(gearRoots.length && gearRoots.every(row => row.benefitPerHour > 0 && row.horizonHours === gearRoots[0].horizonHours),
    'MVP-4: gear roots carry a benefit per hour over one horizon H');
assert(Planner.marketPlanForTarget(original, d.selfId, exactOptions), 'native recovery accepts own D grade');
console.log(JSON.stringify({ nativeWish: activeWish.key, selectedItem: item.selfId, grade: item.etc.rank,
    spentQuote: selected.market.price, finalists: [...shortlist.values()].reduce((n, rows) => n + rows.length, 0) }));
console.log('PASS shared provider/network -> exact native planner: useful intermediate, C alternative, fresh quote, grade/held bounds');
// Execution is a native cold purchase, not an assertion that a helper exists.
(async () => {
    const Database = invoke('Database');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
    const Cold = invoke('GameServer/Bot/Economy/ColdMarketService');
    const { character, amount } = require('./helpers/nativeMarketFixture');
    try {
        Database.init();
        await character(Database, state.characterId, state.name, state.accountName, state.loc);
        await Database.setItem(state.characterId, { selfId: 57, name: 'Adena', amount: state.adena, equipped: false, slot: 0 });
        for (const row of Object.values(state.inventory)) await Database.setItem(state.characterId,
            { selfId: row.selfId, name: Data.items.find(item => item.selfId === row.selfId)?.template.name,
                amount: row.amount, equipped: !!row.equipped, slot: row.slot || 0 });
        await Life.init(); await Afk.init();
        let native = await Life.upsertState({ ...original, activity: 'shopping',
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(state.characterId)),
            stats: { ...original.stats, ...context.statsPacket, equipmentPlan: selected } }, 'fixture_selected_intermediate');
        const quote = Market.npcOffers(item.selfId, 'Dion').find(row => row.price === selected.market.price);
        assert(quote);
        const bought = await Cold.buyOffer(native, quote, { qty: 1 });
        assert(bought.purchased, 'actual cold execution accepts the chosen intermediate');
        const physical = await Database.fetchItems(state.characterId);
        assert.equal(amount(physical, item.selfId), 1);
        assert.equal(amount(physical, 57), state.adena - selected.market.price);
        assert(physical.some(row => Number(row.selfId) === item.selfId && row.equipped),
            'native purchase equips the exact beneficial lower-grade weapon');
        assert.equal(bought.state.adena, amount(physical, 57));
        assert.equal(Number(bought.state.inventory[item.selfId].amount), 1);
        console.log('PASS selected intermediate -> cold native settlement -> exact wallet/item/equip projection');
    } finally {
        await Afk._resetForTests(); await Database.close(); Economy.reset();
        require('node:fs').rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

// Static class/role columns survive a new state object, while live prices,
// wallet and the held target still pass through the same economic shortlist.
{
    Providers.gearCandidates(state);
    const score = Planner.itemScore;
    let scoreCalls = 0;
    Planner.itemScore = (...args) => { scoreCalls++; return score(...args); };
    try {
        const live = { survivalReserve: 1000, price: id => Number(Data.items.find(row => row.selfId === id)?.template.price || 0) };
        const originalPicks = Providers.gearCandidates(state, live);
        const firstCalls = scoreCalls; scoreCalls = 0;
        const copiedPicks = Providers.gearCandidates(structuredClone(state), live);
        assert.deepEqual(copiedPicks, originalPicks, 'new equal owner objects keep exact nominees');
        assert.equal(scoreCalls, firstCalls);
        assert(scoreCalls <= originalPicks.size, 'only currently worn items may need static scoring, not the whole catalogue');
        const source = Data.items;
        const beforeReplacement = Providers.gearCandidates(state);
        try {
            Data.items = source.slice(); scoreCalls = 0;
            assert.deepEqual(Providers.gearCandidates(state), beforeReplacement, 'replacement catalogue preserves every eligible item/order');
            assert(scoreCalls > originalPicks.size, 'a replacement catalogue rebuilds its static columns');
        } finally { Data.items = source; }
    } finally { Planner.itemScore = score; }
}
