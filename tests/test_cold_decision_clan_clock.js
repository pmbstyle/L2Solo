'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('cold-clan-clock');
require('../src/Global');
isolated.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'); Data.init();
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Providers = require(root + '/src/GameServer/Bot/Economy/WishProviders');
const capture = require(root + '/src/GameServer/Bot/Population/ColdEconomyDecision').capture;
const timestamp = 1e12, targetId = 193;
const state = { characterId: 910001, updatedAt: timestamp, phase: 'cold', activity: 'resting', level: 41, adena: 100000,
    exp: Number(Data.experience[40]), sp: 1000,
    inventory: { 1: { selfId: 1, amount: 1, equipped: true, equippedCount: 1, slot: 7 } },
    stats: { classId: 14, classProgressionClassId: 14, classProgressionLevel: 41, clanId: 9,
        equipmentPlan: { status: 'deferred', target: { selfId: targetId, slot: 7 }, strategy: 'none' } },
    loc: { locX: 80000, locY: 148000, locZ: -3500 }, currentRegion: 'Giran',
    timing: { nextResolveAt: timestamp + 60000 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
state.stats.coldCombat = Profile.legacySnapshot(state, Profile.skillRecordsFromTree(14, 41), timestamp);
state.stats.coldCombat.effects = [{ id: 1040, key: 'shield', stats: { pDefMul: 1.15 }, expiresAt: timestamp + 60000 }];
const economy = Economy.forState(state, { timestamp });
assert.equal(economy.itemUsefulness(targetId), 0, 'a real non-top-k clan target takes the native fallback');
const item = Data.items.find(row => Number(row.selfId) === targetId);
assert(Profile.powerFor(state, timestamp).pDef > Profile.powerFor(state, timestamp + 60001).pDef,
    'the native shield effect is active at the simulation clock and expired at the later clock');
function verify(snapshot) {
    const expected = Providers.gearGain(snapshot, item, timestamp);
    const initial = Profile.buildGainsFor(snapshot, timestamp), heldSize = initial.size;
    const decision = capture(economy, snapshot);
    assert.strictEqual(Profile.buildGainsFor(snapshot, timestamp), initial,
        'capturing a clan fallback must not replace the live simulation build with the wall-clock build');
    assert.equal(initial.size, heldSize, 'capture preserves the numeric gains already computed for this build');
    assert.equal(decision.clan.plan.itemId, targetId);
    assert.equal(decision.clan.plan.valueHours,
        Math.max(0, (expected.attack + expected.defence * economy.deathHours) * economy.horizonHours),
        'clan value uses the native projected-state effect at the same simulation timestamp');
    assert.equal(decision.clan.huntPerHour, economy.hunt.perHour);
    assert.equal(decision.clan.horizonHours, economy.horizonHours);
    return decision.clan.plan.valueHours;
}
const originalValue = verify(state);
const projected = { ...state, updatedAt: timestamp + 1, stats: { ...state.stats, classProgressionLevel: 42 },
    inventory: { 1: { ...state.inventory[1], equipped: false, equippedCount: 0 },
        2: { selfId: 2, amount: 1, equipped: true, equippedCount: 1, slot: 7 } } };
assert.notEqual(verify(projected), originalValue,
    'a changed post-progression inventory is valued from the supplied projected state, not the earlier economy state');
assert.equal(invoke('Database').isReady(), false, 'clock capture never initializes a database');
Economy.forget(state.characterId);
fs.rmSync(isolated.directory, { recursive: true, force: true });
console.log('test_cold_decision_clan_clock: ok');
