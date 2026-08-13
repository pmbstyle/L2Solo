const assert = require('assert');

require('../src/Global');

const Actor = invoke('GameServer/Actor/Actor');
const Attack = invoke('GameServer/Actor/Attack');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const C4ArmorSets = invoke('GameServer/Items/C4ArmorSets');
const DataCache = invoke('GameServer/DataCache');
const SkillModel = invoke('GameServer/Model/Skill');
const State = invoke('GameServer/Model/State');
const skillRequest = invoke('GameServer/Actor/Generics/SkillRequest');

function skill(selfId, name, level = 1, overrides = {}) {
    return new SkillModel({
        selfId,
        name,
        level,
        passive: overrides.passive === true,
        spell: overrides.spell === true,
        distance: overrides.distance ?? -1,
        mp: overrides.mp ?? 60,
        hp: 0,
        power: overrides.power ?? 1,
        hitTime: overrides.hitTime ?? 2500,
        reuse: overrides.reuse ?? 10000,
        buff: overrides.buff ?? 120000
    });
}

function effectsActor(overrides = {}) {
    return {
        effects: {},
        skillset: { fetchSkills: () => overrides.skills || [] },
        fetchPassiveSkills: () => [],
        backpack: {
            fetchTotalWeaponKind: () => overrides.weaponKind || '',
            fetchEquippedArmors: () => overrides.armorKind
                ? [{ fetchKind: () => overrides.armorKind }]
                : []
        }
    };
}

const partyState = new State();
const partySkill = skill(264, 'Song of Earth');
const partyActor = {
    state: partyState,
    skillset: { fetchSkill: () => partySkill },
    fetchId: () => 2000001,
    fetchLocX: () => 0,
    fetchLocY: () => 0,
    fetchLocZ: () => 0,
    fetchHead: () => 0,
    fetchDestId: () => undefined,
    canUseSkill: () => true,
    isDead: () => false,
    isBlocked: () => false,
    automation: { fetchDestId: () => undefined, abortAll() {} }
};
const request = { selfId: 264 };
skillRequest({ actor: partyActor, dataSendToMeAndOthers() {} }, partyActor, request);
assert.strictEqual(request.id, partyActor.fetchId(), 'TARGET_PARTY songs must be centered on the caster without a selected target');
assert.strictEqual(partyActor.storedSpell, request, 'a targetless party song must reach the native cast queue');

const seedRequest = { selfId: 1286 };
partyActor.skillset.fetchSkill = () => skill(1286, 'Seed of Water', 1, { spell: true, distance: 600, mp: 200 });
skillRequest({ actor: partyActor, dataSendToMeAndOthers() {} }, partyActor, seedRequest);
assert.strictEqual(seedRequest.id, partyActor.fetchId(), 'TARGET_ONE elemental seeds must preserve the Lisvus self-seeding route');

for (const id of [264, 265, 266, 267, 268, 269, 270, 304, 305, 306, 308, 349, 363, 364]) {
    const semantic = C4SkillRules.resolve({ selfId: id, level: 1 });
    assert.strictEqual(semantic.isDance, true, `song ${id} must use C4 dance MP stacking`);
    assert.strictEqual(semantic.target, 'party', `song ${id} must remain a party buff`);
}
for (const id of [271, 272, 273, 274, 275, 276, 277, 307, 309, 310, 311, 365, 366]) {
    const semantic = C4SkillRules.resolve({ selfId: id, level: 1 });
    assert.strictEqual(semantic.isDance, true, `dance ${id} must use C4 dance MP stacking`);
    assert.strictEqual(semantic.target, 'party', `dance ${id} must remain a party buff`);
    assert.strictEqual(semantic.requires.weaponsAllowed, 512, `dance ${id} must require dual swords`);
}
assert.strictEqual(C4SkillRules.resolve({ selfId: 363, level: 1 }).stats.regMp, 1.2, 'Song of Meditation must increase MP regeneration by 20%');
assert.strictEqual(C4SkillRules.resolve({ selfId: 364, level: 1 }).stats.physicalMpConsumeMul, 0.8, 'Song of Champion must reduce physical MP consumption by 20%');
assert.strictEqual(C4SkillRules.resolve({ selfId: 365, level: 1 }).stats.mCritRateMul, 3, 'Dance of Siren must triple magic critical rate');
assert.strictEqual(C4SkillRules.resolve({ selfId: 366, level: 1 }).stats.silentMoving, true, 'Dance of Shadow must expose sourced SilentMove behavior');

const attack = new Attack();
const singer = effectsActor();
assert.strictEqual(attack.skillMpCost(singer, partySkill), 60, 'the first song must cost its base 60 MP');
EffectStore.apply(singer, { key: 'song_of_earth', id: 264, name: 'Song of Earth', durationMs: 120000 });
assert.strictEqual(attack.skillMpCost(singer, skill(265, 'Song of Life')), 90, 'the second song or dance must add nextDanceCost');
EffectStore.apply(singer, { key: 'song_of_life', id: 265, name: 'Song of Life', durationMs: 120000 });
assert.strictEqual(attack.skillMpCost(singer, skill(271, 'Dance of Warrior')), 120, 'the third song or dance must share the same C4 stack');

const dancerWithoutDuals = effectsActor({ weaponKind: 'Weapon.Sword' });
assert.strictEqual(attack.skillUseConditionFailure(dancerWithoutDuals, skill(271, 'Dance of Warrior')), 'Incorrect weapon.', 'initial dances must reject non-dual weapons too');
const dancerWithDuals = effectsActor({ weaponKind: 'Weapon.Dual' });
assert.strictEqual(attack.skillUseConditionFailure(dancerWithDuals, skill(271, 'Dance of Warrior')), null, 'dual swords must satisfy the dance weapon gate');

const protection = skill(311, 'Dance of Protection', 1, { spell: true, buff: 0 });
assert.strictEqual(protection.fetchSpell(), false, 'Dance of Protection must use the sourced physical song/dance cast type');
assert.strictEqual(protection.fetchBuffTime(), 120000, 'Dance of Protection must last 120 seconds');
const blizzard = skill(1290, 'Blizzard', 1, { spell: true, buff: 0, mp: 250, hitTime: 7000, reuse: 3600000, distance: 900, power: 350 });
assert.strictEqual(blizzard.fetchBuffTime(), 120000, 'Blizzard must retain its sourced 120-second slow');

DataCache.init();
const freezingLevel = DataCache.skills.find((entry) => entry.selfId === 105).levels.find((entry) => entry.level === 24);
assert(freezingLevel, 'the runtime datapack must materialize every sourced C4 class-tree level');
const freezingStrike = skill(105, 'Freezing Strike', freezingLevel.level, { spell: true, distance: 600, power: freezingLevel.power, mp: freezingLevel.mp });
assert.strictEqual(freezingStrike.fetchTargetKind(), 'enemy', 'Freezing Strike must target the enemy rather than the caster');
assert.strictEqual(freezingStrike.fetchPower(), 65, 'Freezing Strike level 24 must use sourced power');
assert.strictEqual(freezingStrike.fetchConsumedMp(), 35, 'Freezing Strike level 24 must use sourced total MP cost');

const passiveActor = effectsActor({
    weaponKind: 'Weapon.Dual',
    armorKind: 'Armor.Fabric',
    skills: [
        skill(144, 'Dual Weapon Mastery', 37, { passive: true }),
        skill(146, 'Anti Magic', 45, { passive: true }),
        skill(213, 'Boost Mana', 8, { passive: true }),
        skill(228, 'Fast Spell Casting', 3, { passive: true }),
        skill(234, 'Robe Mastery', 41, { passive: true }),
        skill(249, 'Weapon Mastery', 42, { passive: true }),
        skill(285, 'Higher Mana Gain', 27, { passive: true })
    ]
});
assert(Math.abs(EffectStats.add(passiveActor, 'pAtkAdd') - 208.7) < 0.001, 'dual and generic weapon masteries must contribute sourced P.Atk at their learned levels');
assert.strictEqual(EffectStats.add(passiveActor, 'mDefAdd'), 108, 'Anti Magic must contribute sourced M.Def');
assert.strictEqual(EffectStats.add(passiveActor, 'maxMpAdd'), 200, 'Boost Mana must contribute sourced max MP');
assert.strictEqual(EffectStats.multiplier(passiveActor, 'castSpdMul'), 1.1, 'Fast Spell Casting must affect casting speed');
assert.strictEqual(EffectStats.add(passiveActor, 'pDefAdd'), 55.2, 'Robe Mastery must work with the local robe item kind');
assert.strictEqual(EffectStats.add(passiveActor, 'gainMp'), 81, 'Higher Mana Gain must affect recharge received');

const renewalActor = effectsActor();
renewalActor.skillReuseUntil = new Map();
renewalActor.fetchCollectiveAtkSpd = () => 333;
renewalActor.fetchCollectiveCastSpd = () => 333;
EffectStore.apply(renewalActor, {
    key: 'song_of_renewal', id: 349, name: 'Song of Renewal', durationMs: 120000,
    stats: C4SkillRules.resolve({ selfId: 349, level: 1 }).stats
});
Actor.prototype.markSkillReuse.call(renewalActor, skill(271, 'Dance of Warrior'), 1000);
assert.strictEqual(renewalActor.skillReuseUntil.get(271), 8000, 'Song of Renewal must reduce physical skill reuse by 30%');

const holyBladeData = DataCache.skills.find((entry) => entry.selfId === 196);
assert.strictEqual(holyBladeData.template.passive, false, 'Holy Blade must be exposed as a toggle, not a passive skill');
const holyBlade = skill(196, 'Holy Blade');
assert.strictEqual(holyBlade.fetchSemantic().operateType, 'toggle', 'Holy Blade must use toggle lifecycle');
assert.strictEqual(holyBlade.fetchSemantic().mpInitialConsume, 8, 'Holy Blade must consume 8 MP on activation');
assert.strictEqual(holyBlade.fetchSemantic().toggleMpConsume, null, 'Holy Blade must not drain MP when the source toggle effect value is zero');

const seededCaster = effectsActor();
EffectStore.apply(seededCaster, { key: 'seed_of_water', id: 1286, name: 'Seed of Water', category: 'element_seed', stats: { seedPower: 2 }, durationMs: 5000 });
assert.strictEqual(attack.skillUseConditionFailure(seededCaster, blizzard), null, 'two water seeds must unlock Blizzard');
EffectStore.remove(seededCaster, 'seed_of_water');
assert.strictEqual(attack.skillUseConditionFailure(seededCaster, blizzard), 'Proper elemental seeds required.', 'Blizzard must reject a caster without two water seeds');

const physicalAttacker = effectsActor();
physicalAttacker.fetchCollectivePAtk = () => 100;
physicalAttacker.fetchCollectiveCritical = () => 0;
physicalAttacker.backpack.fetchTotalWeaponPAtkRnd = () => 0;
physicalAttacker.backpack.fetchTotalWeaponKind = () => 'Weapon.Sword';
EffectStore.apply(physicalAttacker, { key: 'dance_of_light', id: 277, name: 'Dance of Light', durationMs: 120000, stats: { pAtkUndeadMul: 1.3 } });
const undeadTarget = {
    fetchCollectivePDef: () => 100,
    fetchShieldRate: () => 0,
    fetchDex: () => 30,
    fetchUndead: () => true
};
const livingTarget = { ...undeadTarget, fetchUndead: () => false };
assert.strictEqual(attack.prepareMeleeHit(physicalAttacker, undeadTarget, true, false, () => 1).damage, 91, 'Dance of Light must raise physical damage to undead by 30%');
assert.strictEqual(attack.prepareMeleeHit(physicalAttacker, livingTarget, true, false, () => 1).damage, 70, 'Dance of Light must not change damage to living targets');

const baseBreak = invoke('GameServer/Formulas').calcCastBreakChance({ damage: 100, men: 25 });
const concentratedBreak = invoke('GameServer/Formulas').calcCastBreakChance({ damage: 100, men: 25, cancelAdd: -40 });
assert(concentratedBreak < baseBreak, 'Dance of Concentration must reduce sourced cast-break chance');

const darkCrystalCancel = C4ArmorSets.resolveSkill(3535).stats.cancelAdd;
const majorArcanaCancel = C4ArmorSets.resolveSkill(3556).stats.cancelAdd;
assert.strictEqual(darkCrystalCancel, -18, 'Dark Crystal robe must use the shared cast-cancel stat');
assert.strictEqual(majorArcanaCancel, -50, 'Major Arcana robe must use the shared cast-cancel stat');
const armoredCaster = effectsActor();
EffectStore.apply(armoredCaster, { key: 'armor_set:3535', id: 3535, stats: C4ArmorSets.resolveSkill(3535).stats });
assert.strictEqual(EffectStats.add(armoredCaster, 'cancelAdd'), -18, 'cast interruption runtime must see Dark Crystal robe protection');

console.log('Swordsinger, Bladedancer, and Spellsinger skill checks passed');
