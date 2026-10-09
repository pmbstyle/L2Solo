'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Enchant = invoke('GameServer/Items/C4EnchantRules');
const Effects = invoke('GameServer/Items/C4EquipmentItemSkills');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const board = new BoardIndex();
const fixture = require('./fixtures/wish_spot_native_state.json');
const timestamp = 1791335800000, prepare = Profile.withEquipmentPreparation;
const nativeBonus = Enchant.statBonus, nativeEffect = Effects.effectForItem;
let counts;
Enchant.statBonus = (...args) => { counts.enchant++; return nativeBonus(...args); };
Effects.effectForItem = (...args) => { counts.effect++; return nativeEffect(...args); };
function review(original, scoped) {
    const state = structuredClone(original), before = structuredClone(state);
    Economy.reset(); Profile.forgetBuild(state.characterId); counts = { enchant: 0, effect: 0 };
    Profile.withEquipmentPreparation = scoped ? prepare : work => work();
    try {
        const ctx = Economy.forState(state, { spots: [], board, timestamp, npcOffersFor: () => [],
            workshop: { known: true, recipeId: 0, incomePerHour: 0 },
            routeRows: Array.from({ length: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.length },
                () => ({ known: true, durationMs: 0, fee: 0 })) });
        assert.deepEqual(state, before, 'preparation preserves the physical bag, skills, effects and owner');
        return { counts, output: { projection: ctx.projection, network: ctx.network,
            packet: ctx.statsPacket, watch: ctx.watchList, inputKey: ctx.inputKey } };
    } finally { Profile.withEquipmentPreparation = prepare; }
}
try {
    counts = { enchant: 0, effect: 0 };
    const variants = [fixture, { ...fixture, adena: 250 }, { ...fixture, inventory: {} },
        ...[2, 12, 57].map(classId => ({ ...fixture, stats: { ...fixture.stats, classId,
            coldCombat: Profile.legacySnapshot({ level: fixture.level, stats: { classId } }, [], timestamp) } })),
        { ...fixture, level: 39 },
        { ...fixture, stats: { ...fixture.stats, coldCombat: { ...fixture.stats.coldCombat,
            effects: [{ id: 1068, key: 'might', expiresAt: timestamp + 60000, stats: { pAtkMul: 1.15 } }] } } }];
    let removed = 0;
    for (const state of variants) {
        const plain = review(state, false), scoped = review(state, true);
        assert.deepEqual(scoped.output, plain.output, 'complete native wishes, gains, plans, packet and order stay exact');
        assert(scoped.counts.enchant <= plain.counts.enchant);
        removed += plain.counts.enchant - scoped.counts.enchant;
        if (state === fixture) {
            assert(scoped.counts.enchant < plain.counts.enchant / 10);
            assert(scoped.counts.effect < plain.counts.effect / 10);
            console.log(JSON.stringify({ plain: plain.counts, scoped: scoped.counts }));
        }
    }
    assert(removed > 30000, 'native reviews avoid repeated preparation of unchanged items');

    // Native SA effects include mutable stats and conditional rows. Returned
    // profiles must keep the same independent ownership as ordinary calls.
    const weapon = Data.items.find(item => item.selfId === 4682);
    assert(weapon, 'authored Stormbringer Focus');
    const state = { characterId: 990001, level: 65, stats: { classId: 2 }, inventory: {
        4682: { selfId: 4682, amount: 1, equipped: true, slot: 7, enchant: 4 } } };
    state.stats.coldCombat = Profile.legacySnapshot(state, Profile.skillRecordsFromTree(2, 65), timestamp);
    const expected = Profile.profileFor(state, timestamp);
    counts = { enchant: 0, effect: 0 };
    prepare(() => {
        const first = Profile.profileFor(state, timestamp);
        const effect = first.effects.find(row => row.category === 'equipment_item_skill');
        assert(effect); effect.stats.pAtkMul = 999;
        const second = prepare(() => Profile.profileFor(state, timestamp));
        assert.deepEqual(second, expected);
        assert.notStrictEqual(second.effects.find(row => row.category === 'equipment_item_skill'), effect);
    });
    assert.equal(counts.enchant, 4, 'nested preparation reuses the outer item once');
    assert.equal(counts.effect, 1);

    const dual = { ...state, inventory: { 2554: { selfId: 2554, amount: 1, equipped: true, slot: 14, enchant: 4 } } };
    const expectedDual = Profile.profileFor(dual, timestamp);
    prepare(() => {
        const first = Profile.profileFor(dual, timestamp);
        const effect = first.effects.find(row => row.conditionalStats?.length);
        assert(effect, 'authored +4 dual bonus');
        effect.conditionalStats[0].stats.pAccuracyCombatAdd = 999;
        effect.conditionalStats.push({ stats: { pAtkMul: 999 } });
        assert.deepEqual(Profile.profileFor(dual, timestamp), expectedDual, 'conditional effect arrays and stats belong to each profile');
    });

    const changes = [state, { ...state, inventory: { 4682: { ...state.inventory[4682], enchant: 7 } } },
        { ...state, stats: { ...state.stats, hennas: [1] } },
        { ...state, stats: { ...state.stats, coldCombat: { ...state.stats.coldCombat,
            effects: [{ id: 1068, key: 'might', expiresAt: timestamp + 60000, stats: { pAtkMul: 1.15 } }] } } }];
    const expectedChanges = changes.map(value => Profile.profileFor(value, timestamp));
    prepare(() => changes.forEach((value, at) => assert.deepEqual(Profile.profileFor(value, timestamp), expectedChanges[at])));
    const expiring = changes.at(-1), expired = Profile.profileFor(expiring, timestamp + 120000);
    prepare(() => {
        Profile.profileFor(expiring, timestamp);
        assert.deepEqual(Profile.profileFor(expiring, timestamp + 120000), expired, 'buff expiry remains live');
    });
    const GameTime = invoke('GameServer/World/GameTime'), midnight = GameTime.localMidnight(timestamp);
    const nocturnal = { ...state, stats: { ...state.stats, coldCombat: { ...state.stats.coldCombat,
        skillSource: 'database', skills: Profile.skillSnapshotsFromRecords([{ selfId: 294, level: 1 }]) } } };
    const nightTimes = [midnight + 1000, midnight + 7200000];
    const expectedNight = nightTimes.map(at => Profile.profileFor(nocturnal, at));
    prepare(() => nightTimes.forEach((at, index) => assert.deepEqual(Profile.profileFor(nocturnal, at), expectedNight[index])));
    const failure = Error('preparation interrupted');
    assert.throws(() => prepare(() => { Profile.profileFor(state, timestamp); throw failure; }), error => error === failure);
    counts = { enchant: 0, effect: 0 };
    Profile.profileFor(state, timestamp); Profile.profileFor(state, timestamp);
    assert.equal(counts.enchant, 8, 'failure and return retire all prepared rows');

    const overflow = { ...state, inventory: { 4682: { ...state.inventory[4682], enchant: 700 } } };
    const expectedOverflow = Profile.profileFor(overflow, timestamp);
    prepare(() => {
        for (let enchant = 0; enchant < 513; enchant++) Profile.profileFor({ ...state,
            inventory: { 4682: { ...state.inventory[4682], enchant } } }, timestamp);
        counts = { enchant: 0, effect: 0 };
        for (let at = 0; at < 4; at++) assert.deepEqual(Profile.profileFor(overflow, timestamp), expectedOverflow);
        assert.equal(counts.enchant, 16, 'over-limit items remain exact and are not retained');
        assert.equal(counts.effect, 4);
    });

    counts = { enchant: 0, effect: 0 };
    const items = Data.items;
    prepare(() => {
        Profile.profileFor(state, timestamp); Data.items = [...items];
        try { assert.deepEqual(Profile.profileFor(state, timestamp), expected, 'replacement data rebuilds preparation'); }
        finally { Data.items = items; }
    });
    assert.equal(counts.enchant, 8);

    counts = { enchant: 0, effect: 0 };
    prepare(() => {
        Profile.profileFor(state, timestamp);
        const replacement = (...args) => nativeBonus(...args) + 1;
        Enchant.statBonus = replacement;
        try {
            const changed = Profile.profileFor(state, timestamp);
            assert(changed.pAtk > expected.pAtk, 'a replaced rule invalidates the prepared item');
        } finally { Enchant.statBonus = (...args) => { counts.enchant++; return nativeBonus(...args); }; }
    });
    assert.equal(invoke('Database').isReady(), false);
    console.log('PASS native wish equipment preparation: exact projections, fresh effects, changed gear/henna/buffs/night, nesting, disposal, bounds and source invalidation');
} finally {
    Profile.withEquipmentPreparation = prepare; Enchant.statBonus = nativeBonus; Effects.effectForItem = nativeEffect;
    Economy.reset(); Profile.forgetBuild(fixture.characterId);
}
process.exit(0);
