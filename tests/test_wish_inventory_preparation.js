'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('wish-inventory-preparation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const filename = require.resolve('../src/GameServer/Bot/Economy/WishProviders');
const source = fs.readFileSync(filename, 'utf8');
// Native full provider, with only the two per-review scratch readers bypassed.
// Reference gains still go through the common physical combat/armour/skill rules.
let uncached = source.replace(/function wornReader\(state\) \{[\s\S]*?\n\}\n\/\/ What wearing/, `function wornReader(state) {
    return slot => rows(state).find(row => (row.equipped || row.equippedCount > 0)
        && (Number(row.slot) === slot || row.equippedSlots?.includes(slot))) || null;
}
// What wearing`);
uncached = uncached.replace('if (!withoutSlot.has(slot))', 'if (true)')
    .replace('(inventoryEntries ||= Object.entries(state.inventory || {}))', 'Object.entries(state.inventory || {})');
assert.notEqual(uncached, source, 'reference bypass must apply');
const reference = new Module(filename, module);
reference.filename = filename; reference.paths = Module._nodeModulePaths(path.dirname(filename));
reference._compile(uncached, filename);
const subject = Providers.build;
const timestamp = 1791335800000;
const fixture = require('./fixtures/wish_spot_native_state.json');
const board = new BoardIndex();

function review(build, original) {
    const state = structuredClone(original), before = structuredClone(state);
    const oldValues = Object.values, oldEntries = Object.entries;
    const counts = { bagValues: 0, bagEntries: 0 };
    Object.values = value => { if (value === state.inventory) counts.bagValues++; return oldValues(value); };
    Object.entries = value => { if (value === state.inventory) counts.bagEntries++; return oldEntries(value); };
    Economy.reset(); Profile.forgetBuild(state.characterId);
    Providers.build = build;
    try {
        const ctx = Economy.forState(state, { spots: [], board, timestamp, npcOffersFor: () => [],
            routeRows: Array.from({ length: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.length },
                () => ({ known: true, durationMs: 0, fee: 0 })),
            workshop: { known: true, recipeId: 0, incomePerHour: 0 } });
        assert.deepEqual(state, before, 'a hypothetical comparison must not mutate real bag/instances/effects/skills');
        return { counts, output: { projection: ctx.projection, network: ctx.network,
            packet: ctx.statsPacket, watch: ctx.watchList, inputKey: ctx.inputKey } };
    } finally { Object.values = oldValues; Object.entries = oldEntries; Providers.build = subject; }
}

try {
    process.env.L2NODE_PROGRESSION_RATE = 'x50';
    const variants = [fixture,
        { ...fixture, adena: 250 },
        { ...fixture, inventory: {} },
        ...[2, 12, 57].map(classId => ({ ...fixture, stats: { ...fixture.stats, classId,
            coldCombat: Profile.legacySnapshot({ level: fixture.level, stats: { classId } }, [], timestamp) } })),
        { ...fixture, level: 39 },
        { ...fixture, inventory: { ...fixture.inventory, 999999: { selfId: 999999, amount: 1,
            equipped: true, equippedCount: 1, slot: '12', equippedSlots: [13], instances: [] } } },
        { ...fixture, stats: { ...fixture.stats, coldCombat: { ...fixture.stats.coldCombat,
            effects: [{ id: 1068, key: 'might', category: 'buff', expiresAt: timestamp + 60000, stats: { pAtkMul: 1.15 } }] } } }
    ];
    let valuesRemoved = 0, entriesRemoved = 0;
    for (const state of variants) {
        const old = review(reference.exports.build, state), current = review(subject, state);
        assert.deepEqual(current.output, old.output, 'whole native projection/network/queue/packet/watch matches uncached preparation');
        assert(current.counts.bagValues <= old.counts.bagValues);
        assert(current.counts.bagEntries <= old.counts.bagEntries);
        valuesRemoved += old.counts.bagValues - current.counts.bagValues;
        entriesRemoved += old.counts.bagEntries - current.counts.bagEntries;
        console.log(JSON.stringify({ classId: state.stats.classId, level: state.level,
            uncached: old.counts, prepared: current.counts }));
    }
    assert(valuesRemoved > 50, 'real native candidate slots must reuse bag row preparation');
    assert(entriesRemoved > 10, 'several computed native gains must reuse removal bases');
    assert.equal(invoke('Database').isReady(), false);
    console.log(`wish inventory preparation exact parity PASS; bag scans removed=${valuesRemoved}/${entriesRemoved}`);
} finally {
    Providers.build = subject; Economy.reset(); Profile.forgetBuild(fixture.characterId);
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
process.exit(0);
