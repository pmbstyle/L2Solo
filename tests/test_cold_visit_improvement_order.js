'use strict';
// A far bot's town visit collects what it banked for its held exchange before it trades:
// the luxury exchange it came for is made on that visit from the bag the warehouse
// release filled, and what the exchange does not use stays banked (no refusal, no
// withdraw-then-deposit of the same crystals). Stock collected from the bank is not
// material the bot obtained: it tells nobody it found it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('cold-visit-improvement-order');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const Native = require('./helpers/nativeMarketFixture');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Index = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const location = { locX: 83396, locY: 147904, locZ: -3400 };
const CRYSTAL = 1458;
const banks = new Map();
// A bot in Giran with 50 D crystals in its bag and 245 banked, saving for the earring exchange.
async function seed(id, earring) {
    const name = `BankedExchange${id}`, account = `bot_banked_exchange_${id}`;
    await Native.character(DB, id, name, account, location);
    await DB.execute(['UPDATE characters SET level=33,classId=54,race=4,exp=? WHERE id=?', [Data.experience[32], id]]);
    await DB.setItem(id, { selfId: 57, name: 'Adena', amount: 30000000 });
    for (const row of Gear.planFor({ classId: 54, level: 20 }).items)
        await DB.setItem(id, { ...row, amount: 1, equipped: true, enchant: 0,
            name: Data.items.find(item => item.selfId === row.selfId).template.name });
    await DB.setItem(id, { selfId: CRYSTAL, name: 'Crystal: D-Grade', amount: 50, stackable: true });
    await DB.execute(['INSERT INTO warehouse_items(characterId,selfId,name,amount,enchant) VALUES(?,?,?,?,0)',
        [id, CRYSTAL, 'Crystal: D-Grade', 245]]);
    banks.set(id, [[CRYSTAL, 245, 0]]);
    return Life.upsertState({ characterId: id, accountName: account, name,
        phase: 'cold', activity: 'shopping', level: 33, exp: Data.experience[32], adena: 30000000,
        currentRegion: 'Giran', loc: location, inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)), timing: {},
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, stats: { classId: 54, money: [0, 0, 0, 0],
            equipmentPlan: { strategy: 'luxury_exchange', status: 'active', target: { selfId: 852, slot: 1 },
                exchange: earring, materials: earring.materials } } }, 'banked_exchange_fixture');
}
async function run() {
    const keptRecord = LifeEvents.recordMany, recorded = [];
    try {
        fixture.assertConfigured(options.default);
        await DB.init(); await Life.init();
        Index.useRowSource(owner => banks.has(Number(owner)) ? Index.prepareRow([Number(owner), 1, banks.get(Number(owner))]) : undefined,
            () => true);
        LifeEvents.recordMany = (characterId, events) => { recorded.push(...events.map(event => ({ characterId, ...event })));
            return keptRecord.call(LifeEvents, characterId, events); };
        const Luxury = invoke('GameServer/Bot/Economy/BotLuxuryExchange');
        const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
        const Population = invoke('GameServer/Bot/Population/PopulationService');
        const earring = { kind: 'luxury_exchange', ...Luxury.recipes().get(852) };
        assert.deepEqual(earring.materials, [{ selfId: CRYSTAL, amount: 195 }], 'the earring costs 195 D crystals');
        const round = () => ({ patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
            nextResolveAt: Date.now() + 30000, debug: {} });

        const exchanging = await seed(9661, earring);
        assert(Luxury.eligible(exchanging, earring), 'the bot may take the C earring');
        const visit = await Population.resolveColdState(exchanging, {
            precomputedPlan: { previousPlan: exchanging.stats.equipmentPlan, acquisitionPlan: exchanging.stats.equipmentPlan,
                economyDecision: Decision.capture({ riskWeight: 1, network: { activity: {
                    activity: 'improving', kind: 'luxury_exchange', improvement: earring, town: 'Giran' } } }, exchanging) },
            precomputedResult: round()
        });
        assert(visit.ok, 'the visit applies');
        const bag = await DB.fetchItems(9661), bank = await DB.fetchWarehouseItems(9661);
        assert.equal(Native.amount(bag, 852), 1, 'the exchange is made on the visit that collects its banked crystals');
        assert.equal(visit.state.stats.lastImprovement?.kind, 'luxury_exchange');
        assert.equal(Native.amount(bag, CRYSTAL), 0, 'the bag paid 50 of its own and 145 collected from the bank');
        assert.equal(Native.amount(bank, CRYSTAL), 100, 'the 100 crystals the exchange does not use stay banked');
        assert(!(visit.state.stats.lastWarehouseDeposit?.items || []).some(item => Number(item.selfId) === CRYSTAL),
            'no collected crystal is deposited back on the same visit');

        // A visit that only collects (no improvement this step) while the bot also farms the
        // same crystals for a craft: the 145 it took out of its bank are not crystals it found.
        const collecting = await seed(9662, earring);
        const farmed = { strategy: 'craft', status: 'active', target: { selfId: 852, slot: 1 },
            materials: [{ selfId: CRYSTAL, amount: 195 }], next: { itemId: CRYSTAL } };
        const collected = await Population.resolveColdState(collecting, {
            precomputedPlan: { previousPlan: farmed, acquisitionPlan: farmed }, precomputedResult: round()
        });
        assert(collected.ok, 'the collecting visit applies');
        assert.equal(Native.amount(await DB.fetchItems(9662), CRYSTAL), 195, 'the visit collected the banked share');
        assert.deepEqual(recorded.filter(event => event.characterId === 9662 && event.type === 'craft_material_progress'), [],
            'stock collected from the bank records no material progress');
        console.log('Cold visit improvement order: a banked exchange input is collected before the exchange, and not told as found, passed');
    } finally {
        LifeEvents.recordMany = keptRecord;
        Index.useRowSource();
        await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
