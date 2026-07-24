const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

DataCache.init();

const timestamp = 1_750_000_000_000;
const fighter = {
    characterId: 901,
    name: 'ColdFighter',
    level: 12,
    activity: 'hunting',
    vitals: { hp: 500, maxHp: 500, mp: 200, maxMp: 200 },
    stats: {
        classId: 0,
        coldCombat: {
            version: 1,
            classId: 0,
            base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
            equipment: { weaponKind: 'Weapon.Sword', pAtk: 80, pAtkRnd: 10, mAtk: 40, atkSpd: 379, critical: 80, accur: 0, pDef: 120, mDef: 50, evasion: 0, bonusMp: 0, shieldPDef: 0 },
            effects: [{ key: 'might', id: 1, type: 'buff', expiresAt: timestamp + 60000, stats: { pAtkMul: 2 } }],
            skills: [{ selfId: 3, level: 4, passive: false, spell: false, power: 51, mp: 7, hitTime: 0, reuse: 2000 }]
        }
    },
    inventory: {},
    party: { role: 'dps' }
};

const buffed = ColdCombatProfile.profileFor(fighter, timestamp);
const expired = ColdCombatProfile.profileFor(fighter, timestamp + 60001);
assert(buffed.pAtk > expired.pAtk, 'an active persisted buff must affect cold combat and expire by its real deadline');
assert.strictEqual(ColdCombatProfile.offensiveSkills(buffed).length, 1, 'the profile must retain compatible learned combat skills');
const legacyBuffed = ColdCombatProfile.profileFor({
    ...fighter,
    stats: { ...fighter.stats, coldCombat: { ...fighter.stats.coldCombat, effects: [{ key: 'might', id: 1068, type: 'buff', expiresAt: timestamp + 60000, stats: {} }] } }
}, timestamp);
assert(legacyBuffed.pAtk > expired.pAtk, 'legacy catalog buffs with an empty effect payload must retain their C4 stat bonus');
const persistedSkills = ColdCombatProfile.skillSnapshotsFromRecords([
    { selfId: 3, level: 4, passive: false },
    { selfId: 999999, level: 1, passive: false }
]);
assert.deepStrictEqual(persistedSkills.map((skill) => [skill.selfId, skill.level]), [[3, 4]], 'legacy migration must use persisted skill rows and ignore only unknown datapack entries');
const migratedSnapshot = ColdCombatProfile.legacySnapshot(fighter, [{ selfId: 3, level: 4 }], timestamp);
assert.strictEqual(migratedSnapshot.skills[0].level, 4, 'legacy snapshot must preserve the stored skill level');
assert.strictEqual(migratedSnapshot.skillSource, 'database', 'legacy snapshot must prevent a later fallback from replacing persisted skills');
assert.strictEqual(migratedSnapshot.version, ColdCombatProfile.PROFILE_VERSION, 'a database snapshot must record the current completeness contract');
assert.strictEqual(ColdCombatProfile.needsDatabaseBackfill({ skillSource: 'database', version: 1 }), true, 'a truncated version-one database snapshot must be repaired once');
assert.strictEqual(ColdCombatProfile.needsDatabaseBackfill(migratedSnapshot), false, 'a current database snapshot must not be rescanned on every migration tick');
assert.strictEqual(ColdCombatProfile.needsDatabaseBackfill({ version: ColdCombatProfile.PROFILE_VERSION }), true, 'a class-tree fallback without a database source must still be migrated');

const changedGear = ColdCombatProfile.profileFor({
    ...fighter,
    inventory: { '1': { selfId: 1, equipped: true } },
    stats: { ...fighter.stats, coldCombat: { ...fighter.stats.coldCombat, equipment: { ...fighter.stats.coldCombat.equipment, pAtk: 1 } } }
}, timestamp);
assert.strictEqual(changedGear.equipment.pAtk, 8, 'cold inventory equipment must override a stale hot snapshot after a market or craft upgrade');

const spot = {
    id: 'gremlin_field',
    name: 'Gremlin field',
    avgLevel: 1,
    density: 1,
    npcSelfIds: [1],
    rewards: { exp: 10, sp: 2, adenaMin: 1, adenaMax: 1 },
    // Deliberately contradictory placeholders: the resolver must take the
    // real NPC profile from the datapack when npcSelfIds are available.
    mob: { hp: 1, damage: 9999 }
};
const result = BackgroundResolver.resolveSolo({ state: fighter, spot, elapsedMs: 12000, timestamp, rng: () => 0.1 });
assert(result.debug.combatActions > 0, 'cold combat must execute bounded combat actions');
assert(result.debug.skillUses > 0, 'a usable learned skill must be cast during cold combat');
assert(result.patch.stats.coldCombat.cooldowns[3] > timestamp, 'skill reuse must survive a cold resolve');
assert(result.patch.vitals.hp > 0, 'datapack Gremlin damage must be used instead of the synthetic spot damage');

const injuredTank = {
    ...fighter,
    characterId: 902,
    vitals: { hp: 10, maxHp: 500, mp: 200, maxMp: 200 },
    party: { role: 'tank' },
    stats: { ...fighter.stats, coldCombat: { ...fighter.stats.coldCombat, equipment: { ...fighter.stats.coldCombat.equipment, pAtk: 1, critical: 0 } } }
};
const healer = {
    ...fighter,
    characterId: 903,
    party: { role: 'healer' },
    stats: {
        ...fighter.stats,
        coldCombat: {
            ...fighter.stats.coldCombat,
            skills: [{ selfId: 69, level: 1, passive: false, spell: true, power: 120, mp: 1, hitTime: 1000, reuse: 1000 }]
        }
    }
};
const partyFight = BackgroundResolver.resolvePartyFight({
    members: [injuredTank, healer],
    spot: { ...spot, npcSelfIds: [], mob: { hp: 10000, damage: 1 } },
    timestamp,
    rng: () => 0.1
});
assert(partyFight.debug.actions > 0, 'party cold combat must execute one shared NPC encounter');
assert(partyFight.members[1].heals > 0, 'a learned friendly heal must be applied to an injured party member');

const partyResult = BackgroundPartyResolver.resolve({
    party: { partyId: 'cold_combat_party', cohesion: 1, risk: 0, roleCoverage: { tank: 1, healer: 1 }, stats: {} },
    members: [injuredTank, healer],
    spot: { ...spot, npcSelfIds: [], mob: { hp: 10000, damage: 1 } },
    elapsedMs: 12000,
    timestamp,
    rng: () => 0.1
});
assert(partyResult.debug.combatActions > 0, 'the party lifecycle must use the cold action simulation');
assert(partyResult.debug.heals > 0, 'party support casts must be reflected in the persisted combat telemetry');

const originalMigrateLegacyColdCombatProfiles = PopulationService.migrateLegacyColdCombatProfiles;
const originalMigrationRunning = PopulationService.coldCombatProfileMigrationRunning;
const originalNextMigrationAt = PopulationService.nextColdCombatProfileMigrationAt;
let profileMigrationCalls = 0;
PopulationService.migrateLegacyColdCombatProfiles = () => {
    profileMigrationCalls++;
    return Promise.resolve([]);
};
PopulationService.coldCombatProfileMigrationRunning = false;
PopulationService.nextColdCombatProfileMigrationAt = 0;
Promise.resolve()
    .then(() => PopulationService.maybeMigrateLegacyColdCombatProfiles(1000))
    .then(() => PopulationService.maybeMigrateLegacyColdCombatProfiles(1001))
    .then(() => PopulationService.maybeMigrateLegacyColdCombatProfiles(11000))
    .then(() => {
        assert.strictEqual(profileMigrationCalls, 2, 'the post-resolve cold-profile migration must run initially and respect its cadence');
        console.log('Cold combat profile checks passed');
    })
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => {
        PopulationService.migrateLegacyColdCombatProfiles = originalMigrateLegacyColdCombatProfiles;
        PopulationService.coldCombatProfileMigrationRunning = originalMigrationRunning;
        PopulationService.nextColdCombatProfileMigrationAt = originalNextMigrationAt;
    });
