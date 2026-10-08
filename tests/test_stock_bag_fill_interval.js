'use strict';
const assert = require('node:assert/strict');
require('../src/Global'); invoke('GameServer/DataCache').init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const saved = { value: Table.value, best: Table.best, hunt: Hunt.huntIncome };
let stacks = 10, rowPresent = true, spotPresent = true, potions = 2, income = 100000;
const fixture = { characterId: 91819, level: 30, phase: 'hot', activity: 'hunting',
    stats: { classId: 1, visitEvery: [22, 24] }, party: { partyId: 1 }, vitals: { hp: 1000, mp: 1000 }, loc: {},
    inventory: { 1: { selfId: 1, amount: 39, stackable: false },
        1061: { selfId: 1061, amount: 1, stackable: true } } };
Hunt.huntIncome = () => ({ spotId: spotPresent ? 'stack-fixture' : null, perHour: income, expPerHour: 1000000 });
const row = withShots => ({ exp: withShots ? 1e6 : 5e5, shots: 1000, potions, deaths: .1, stacks });
Table.value = (id, role, level, withShots) => rowPresent ? row(withShots) : null;
Table.best = () => row(true);
const target = (state = fixture) => Economy.basics(state, { spots: [] }).stock('potions').targetHours;
try {
    assert.equal(target(), 4, '80 slots - 40 physical slots with an existing kit, 10 new slots/h -> 4h');
    const emptyPotion = { ...fixture, inventory: { 1: { selfId: 1, amount: 40, stackable: false } } };
    assert.equal(target(emptyPotion), 3.9, 'an absent positive-use potion reserves its refill slot');
    const filledPotion = { ...emptyPotion, inventory: { ...emptyPotion.inventory,
        1061: { selfId: 1061, amount: 8, stackable: true } } };
    assert.equal(target(filledPotion), target(emptyPotion), 'creating the purchased potion stack cannot lower its target');
    const emptyKit = { ...fixture, inventory: { 1: { selfId: 1, amount: 39, stackable: false },
        126: { selfId: 126, amount: 1, equipped: true, equippedCount: 1, slot: 7, stackable: false } } };
    const emptyStock = Economy.basics(emptyKit, { spots: [] });
    assert(emptyStock.stock('shots').usePerHour > 0);
    assert.equal(target(emptyKit), 3.8, 'both absent positive-use kit stacks reserve a slot');
    const filledKit = { ...emptyKit, inventory: { ...emptyKit.inventory,
        1463: { selfId: 1463, amount: emptyStock.stock('shots').target, stackable: true },
        1061: { selfId: 1061, amount: emptyStock.stock('potions').target, stackable: true } } };
    assert.equal(target(filledKit), 3.8, 'the existing full kit keeps the exact physical free-slot formula');
    assert.equal(Economy.basics(filledKit, { spots: [] }).stock('shots').target, emptyStock.stock('shots').target);
    assert.equal(Economy.basics(filledKit, { spots: [] }).stock('potions').target, emptyStock.stock('potions').target);
    assert.equal(target({ ...fixture, inventory: {} }), 7.9, 'an otherwise empty bag reserves only the used potion');
    income = 1;
    assert.equal(Economy.basics(emptyKit, { spots: [] }).stock('shots').usePerHour, 0);
    assert.equal(target(emptyKit), 3.9, 'unprofitable shots reserve no slot; the used potion still reserves one');
    income = 100000; potions = 0;
    assert.equal(target({ ...fixture, inventory: {} }), 8, 'zero-use kit reserves no slots');
    potions = 2;
    assert.equal(target({ ...fixture, inventory: { 1: { selfId: 1, amount: 80, stackable: false } } }), .5,
        'zero free room still clamps to half an hour');
    stacks = 0; assert.equal(target(), 24, 'no new slots -> cap24h');
    stacks = null; assert.equal(target(), 24, 'missing table preserves the learned duration');
    stacks = 10; rowPresent = false; assert.equal(target(), 24, 'missing best-spot row preserves history despite generic fallback table');
    rowPresent = true; spotPresent = false; assert.equal(target(), 24, 'no best spot preserves history');
    spotPresent = true; stacks = 1000; assert.equal(target(), .5, 'full bag interval clamps to half an hour');
    assert.equal(target({ ...fixture, stats: { ...fixture.stats, visitEvery: [22, 4] } }), .5,
        'an observed long interval cannot exceed an earlier known physical return');
    stacks = 10; assert.equal(target({ ...fixture, stats: { classId: 53, visitEvery: [22, 24] } }), 6, 'native dwarf class uses100-slot bag');
    assert.equal(target({ ...fixture, inventory: { 1864: { selfId: 1864, amount: 40, stackable: true } } }), 7.8,
        'stackable material occupies one slot and its absent potion reserves one');
    assert.equal(target({ ...fixture, stats: { classId: 1 }, inventory: {} }), 2,
        'an empty bag without history never sets the outing to its full capacity');
    assert.equal(target({ ...fixture, stats: { classId: 1, visitEvery: [22, 1] }, inventory: {} }), 1,
        'an empty bag preserves the learned shorter outing');
    const solo = { ...fixture, party: null, inventory: { 1: { selfId: 1, amount: 19, stackable: false },
        1061: { selfId: 1061, amount: 1, stackable: true } } };
    assert.equal(target(solo), 2, 'known free solo loot: 40-slot sale threshold minus 20 held / 10 slots per hour');
    assert.equal(target({ ...solo, stats: { ...solo.stats, visitEvery: [22, 8] } }), 2,
        'learned eight hours yields to the earlier executable sale');
    assert.equal(target({ ...solo, stats: { ...solo.stats, visitEvery: [22, 1] } }), 1,
        'a learned earlier visit remains earlier than the bag sale');
    assert.equal(target({ ...solo, phase: 'cold' }), target(solo), 'hot and cold use the identical stock horizon');
    assert.equal(target({ ...solo, partyId: 2 }), 6, 'standalone party membership retains the full-bag bound');
    assert.equal(target({ ...solo, stats: { ...solo.stats, generatedCold: true }, level: 9 }), 5.9,
        'pre-trade bots cannot forecast a sale they cannot execute');
    assert.equal(target({ ...solo, stats: { ...solo.stats, marketSellRetryAfter: Date.now() + 60000 } }), 6,
        'blocked sale does not claim an executable half-full return');
    const protectedLoot = { ...solo, inventory: { 1864: { selfId: 1864, amount: 1, stackable: true } },
        stats: { ...solo.stats, equipmentPlan: { status: 'active', strategy: 'craft', materials: [{ selfId: 1864, amount: 1 }] } } };
    assert.equal(target(protectedLoot), 7.8, 'reserved craft input cannot justify an early sale');
    assert.equal(target({ ...solo, inventory: { 1864: { selfId: 1864, amount: 1, stackable: true } } }), 3.8,
        'free material and planned potion occupy two of 40 sale slots');
    const ownKitOnly = { ...solo, inventory: { 126: { selfId: 126, amount: 1, equipped: true,
        equippedCount: 1, slot: 7, stackable: false }, 1463: { selfId: 1463, amount: 1000000, stackable: true },
        1061: { selfId: 1061, amount: 1000000, stackable: true } } };
    assert.equal(target(ownKitOnly), 7.7, 'own usable consumable surplus never shortens its own forecast');
    stacks = 0;
    assert.equal(target({ ...solo, inventory: { 1: { selfId: 1, amount: 39, stackable: false },
        1061: solo.inventory[1061] } }), .5, 'reached sale threshold is imminent even with zero new slots/hour');
    rowPresent = false;
    assert.equal(target({ ...solo, stats: { ...solo.stats, visitEvery: [22, 8] } }), 8,
        'an absent table cannot cap learned eight hours without an earlier known return');
    rowPresent = true; stacks = 10;
    const changedDescription = { ...protectedLoot, stats: { ...protectedLoot.stats,
        equipmentPlan: { ...protectedLoot.stats.equipmentPlan, reason: 'different', expectedEffort: 123,
            targetProgress: 1, at: Date.now() } } };
    assert.equal(Economy.inputKey(protectedLoot), Economy.inputKey(changedDescription),
        'plan metadata cannot invalidate the reservation-dependent economic context');
    assert.notEqual(Economy.inputKey(protectedLoot), Economy.inputKey({ ...protectedLoot, stats: {
        ...protectedLoot.stats, equipmentPlan: { ...protectedLoot.stats.equipmentPlan,
            materials: [{ selfId: 1864, amount: 2 }] } } }), 'changed reserved quantities invalidate');
    const retryState = { ...solo, stats: { ...solo.stats, marketSellRetryAfter: 1000 } };
    assert.notEqual(Economy.inputKey(retryState, { timestamp: 999 }), Economy.inputKey(retryState, { timestamp: 1001 }),
        'expiry of this bots existing sale retry releases its earlier sale forecast');
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const before = Economy.basics; let recursiveCalls = 0;
    Economy.basics = (...args) => { recursiveCalls++; return before(...args); };
    try { Disposition.saleCandidates(solo, { unlimited: true }); assert.equal(recursiveCalls, 1,
        'ordinary sale prepares the economics once; forecast presence never recursively calls it'); }
    finally { Economy.basics = before; }
    assert.notEqual(Economy.inputKey(solo), Economy.inputKey({ ...solo, partyId: 2 }));
    assert.notEqual(Economy.inputKey(solo), Economy.inputKey(protectedLoot));
    console.log('test_stock_bag_fill_interval: ok');
} finally { Table.value = saved.value; Table.best = saved.best; Hunt.huntIncome = saved.hunt; }
