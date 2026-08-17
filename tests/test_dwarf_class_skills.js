const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const AttackRange = invoke('GameServer/Actor/AttackRange');
const calculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
const skillExec = invoke('GameServer/Actor/Generics/SkillExec');
const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const Formulas = invoke('GameServer/Formulas');
const SpoilSweep = invoke('GameServer/Npc/SpoilSweep');
const SkillModel = invoke('GameServer/Model/Skill');
const ToggleSkills = invoke('GameServer/Skills/ToggleSkills');
const skillTree = require('../data/Skills/Tree/tree.json');

function skill(selfId, name, level = 1, overrides = {}) {
    return new SkillModel({
        selfId,
        name,
        level,
        passive: overrides.passive === true,
        spell: overrides.spell === true,
        distance: overrides.distance ?? -1,
        mp: overrides.mp ?? 0,
        hp: overrides.hp ?? 0,
        power: overrides.power ?? 1,
        hitTime: overrides.hitTime ?? 0,
        reuse: overrides.reuse ?? 0,
        buff: overrides.buff ?? 0
    });
}

function actor(overrides = {}) {
    const value = {
        effects: {},
        mp: overrides.mp ?? 1000,
        hp: overrides.hp ?? 1000,
        maxHp: overrides.maxHp ?? 1000,
        destId: overrides.destId ?? 9001,
        skillset: { fetchSkills: () => overrides.skills || [], fetchSkill: () => null },
        fetchPassiveSkills: () => [],
        fetchId: () => overrides.id ?? 2000001,
        fetchName: () => overrides.name || 'Dwarf',
        fetchLevel: () => overrides.level ?? 78,
        fetchLocX: () => overrides.x ?? 100,
        fetchLocY: () => overrides.y ?? 200,
        fetchLocZ: () => overrides.z ?? 300,
        fetchRadius: () => overrides.radius ?? 0,
        fetchHead: () => overrides.head ?? 0,
        fetchStr: () => overrides.str ?? 40,
        fetchDex: () => overrides.dex ?? 30,
        fetchCollectivePAtk: () => overrides.pAtk ?? 100,
        fetchCollectivePDef: () => overrides.pDef ?? 100,
        fetchCollectiveMAtk: () => 100,
        fetchCollectiveMDef: () => 100,
        fetchCollectiveAtkSpd: () => 333,
        fetchCollectiveCastSpd: () => 333,
        fetchMp() { return this.mp; },
        setMp(next) { this.mp = next; },
        fetchHp() { return this.hp; },
        setHp(next) { this.hp = next; },
        fetchMaxHp() { return this.maxHp; },
        fetchDestId() { return this.destId; },
        clearDestId() { this.destId = undefined; },
        statusUpdateVitals() {},
        isDead: () => false,
        automation: {
            aborted: false,
            abortAll() { this.aborted = true; },
            replenishVitals() {},
            scheduleAction(_session, _actor, _target, _distance, callback) { callback(); }
        },
        attack: { cleared: false, clearTimers() { this.cleared = true; }, resetQueuedEvent() {} },
        state: {
            hits: true,
            casts: true,
            combats: true,
            inMotion: () => false,
            fetchWalkin: () => false,
            fetchSeated: () => false,
            fetchDead: () => false,
            setHits(next) { this.hits = next; },
            setCasts(next) { this.casts = next; },
            setCombats(next) { this.combats = next; }
        },
        backpack: {
            fetchTotalWeaponKind: () => overrides.weaponKind || 'Weapon.Blunt',
            fetchEquippedArmors: () => (overrides.armorKinds || ['Armor.Chain'])
                .map((kind) => ({ fetchKind: () => kind })),
            fetchTotalShieldPDef: () => 0,
            fetchTotalWeaponPAtkRnd: () => 0
        }
    };
    return value;
}

function session(value) {
    return {
        actor: value,
        packets: [],
        dataSendToMe(packet) { this.packets.push(packet); },
        dataSendToMeAndOthers(packet) { this.packets.push(packet); }
    };
}

const dwarfClassSkills = new Map([
    [53, [1320, 1321, 1322, 42, 141, 142, 150, 172, 194, 254]],
    [54, [1320, 34, 100, 148, 150, 205, 211, 212, 216, 227, 231, 239, 245, 254, 302]],
    [55, [1320, 34, 36, 60, 148, 150, 205, 211, 212, 216, 227, 231, 239, 254, 260, 302, 320]],
    [56, [1320, 25, 34, 100, 148, 150, 172, 205, 211, 212, 216, 227, 231, 239, 245, 248]],
    [57, [1320, 13, 25, 34, 36, 148, 150, 172, 205, 211, 212, 216, 227, 231, 239, 248, 260, 299, 301, 320]],
    [117, [329, 328, 348, 362, 340, 330, 347, 339]],
    [118, [329, 328, 362, 340, 330, 347, 339]]
]);

for (const [classId, expectedIds] of dwarfClassSkills) {
    const tree = skillTree.find((entry) => entry.classId === classId);
    assert(tree, `dwarf class ${classId} should have a C4 skill tree`);
    assert.deepStrictEqual(
        [...new Set(tree.skills.map((entry) => entry.selfId))].sort((a, b) => a - b),
        [...expectedIds].sort((a, b) => a - b),
        `dwarf class ${classId} should match the Lisvus class skill list`
    );
}

DataCache.init();
const cached = (id) => DataCache.skills.find((entry) => entry.selfId === id);
for (const [id, maxLevel] of new Map([
    [141, 3], [142, 5], [148, 8], [150, 3], [172, 9], [194, 1],
    [205, 45], [211, 10], [212, 8], [216, 45], [227, 50], [231, 50], [248, 5]
])) {
    assert.strictEqual(cached(id).levels.length, maxLevel, `dwarf passive ${id} should materialize all ${maxLevel} C4 levels`);
    assert.strictEqual(cached(id).template.passive, true, `dwarf passive ${id} should never fall through as an active attack`);
}

const basePassives = actor({
    skills: [
        skill(141, 'Weapon Mastery', 3, { passive: true }),
        skill(142, 'Armor Mastery', 5, { passive: true }),
        skill(150, 'Weight Limit', 3, { passive: true }),
        skill(211, 'Boost HP', 10, { passive: true })
    ],
    armorKinds: ['Armor.Leather']
});
assert.strictEqual(EffectStats.multiplier(basePassives, 'pAtkMul'), 1.085, 'Dwarven Weapon Mastery should apply its sourced P.Atk multiplier');
assert.strictEqual(EffectStats.add(basePassives, 'pAtkAdd'), 4, 'Dwarven Weapon Mastery level 3 should add 4 P.Atk');
assert.strictEqual(EffectStats.add(basePassives, 'pDefAdd'), 14, 'base Armor Mastery level 5 should add 14 P.Def in light armor');
assert.strictEqual(EffectStats.add(basePassives, 'pEvasionRateAdd'), 3, 'base Armor Mastery level 5 should add 3 evasion only in light armor');
assert.strictEqual(EffectStats.multiplier(basePassives, 'maxLoadMul'), 4, 'Weight Limit level 3 should quadruple carrying capacity');
assert.strictEqual(EffectStats.add(basePassives, 'maxHpAdd'), 480, 'Boost HP level 10 should add 480 HP');

const robeDwarf = actor({ skills: [skill(142, 'Armor Mastery', 5, { passive: true })], armorKinds: ['Armor.Fabric'] });
assert.strictEqual(EffectStats.add(robeDwarf, 'pDefAdd'), 0, 'base Armor Mastery should not apply to robes');
assert.strictEqual(EffectStats.add(robeDwarf, 'pEvasionRateAdd'), 0, 'base Armor Mastery evasion should not apply to robes');

const advancedPassives = actor({
    skills: [
        skill(205, 'Blunt Mastery', 45, { passive: true }),
        skill(216, 'Polearm Mastery', 45, { passive: true }),
        skill(227, 'Light Armor Mastery', 50, { passive: true }),
        skill(231, 'Heavy Armor Mastery', 50, { passive: true })
    ],
    weaponKind: 'Weapon.Blunt',
    armorKinds: ['Armor.Leather']
});
assert.strictEqual(EffectStats.add(advancedPassives, 'pAtkAdd'), 129.3, 'Blunt Mastery should apply only its level-45 blunt bonus');
assert.strictEqual(EffectStats.add(advancedPassives, 'pDefAdd'), 81.3, 'Light Armor Mastery level 50 should add sourced P.Def');
assert.strictEqual(EffectStats.add(advancedPassives, 'pEvasionRateAdd'), 6, 'Light Armor Mastery level 50 should add sourced evasion');
advancedPassives.backpack.fetchTotalWeaponKind = () => 'Weapon.Pole';
assert.strictEqual(EffectStats.add(advancedPassives, 'pAtkAdd'), 129.3, 'Polearm Mastery should replace the blunt bonus when a pole is equipped');
assert.strictEqual(EffectStats.add(advancedPassives, 'atkCountMaxAdd'), 10, 'Polearm Mastery level 45 should expose ten additional attack targets');

const poleAttack = new Attack();
const poleUser = actor({
    id: 2000010,
    x: 0,
    y: 0,
    z: 0,
    radius: 9,
    weaponKind: 'Weapon.Pole',
    skills: [skill(216, 'Polearm Mastery', 45, { passive: true })]
});
const poleTarget = (id, x, y, z = 0, radius = 0) => ({
    fetchId: () => id,
    fetchLocX: () => x,
    fetchLocY: () => y,
    fetchLocZ: () => z,
    fetchRadius: () => radius,
    fetchAttackable: () => true,
    isDead: () => false,
    state: { fetchDead: () => false }
});
const polePrimary = poleTarget(1000010, 20, 0, 0, 10);
const poleSecondary = poleTarget(1000011, 30, 10, 0, 10);
const poleBehind = poleTarget(1000012, -20, 0, 0, 10);
const poleWithinRange = poleTarget(1000013, 75, 0, 0, 6);
const poleOutsideRange = poleTarget(1000014, 82, 0, 0, 6);
const poleAbove = poleTarget(1000015, 20, 0, 700, 6);
poleAttack.fetchSkillTargetsInRadius = () => [polePrimary, poleSecondary, poleBehind, poleWithinRange, poleOutsideRange, poleAbove];
assert.strictEqual(AttackRange.effectiveRange(poleUser, poleWithinRange, 66), 81, 'polearm range should include both collision radii');
assert.deepStrictEqual(
    poleAttack.resolveMeleeTargets(poleUser, polePrimary).map((target) => target.fetchId()),
    [polePrimary.fetchId(), poleSecondary.fetchId(), poleWithinRange.fetchId()],
    'Polearm Mastery should add targets inside the native 66-range, 120-degree attack arc'
);
EffectStore.apply(poleUser, { key: 'focus_attack', id: 317, type: 'buff', stats: { hitMainTarget: true } });
assert.deepStrictEqual(poleAttack.resolveMeleeTargets(poleUser, polePrimary), [polePrimary], 'Focus Attack should collapse a polearm swing back to its main target');

const runtimePoleAttack = new Attack();
const runtimePoleSession = session(poleUser);
const runtimeTimers = [];
const runtimeDamage = [];
runtimePoleAttack.resolveMeleeTargets = () => [polePrimary, poleSecondary];
runtimePoleAttack.prepareMeleeHit = () => ({ damage: 100, flags: 0 });
runtimePoleAttack.queueTimer = (callback) => runtimeTimers.push(callback);
runtimePoleAttack.hit = (_session, _actor, target, damage) => runtimeDamage.push([target.fetchId(), damage]);
runtimePoleAttack.applyDamageAbsorb = () => 0;
const originalRandom = Math.random;
Math.random = () => 0;
try {
    runtimePoleAttack.meleeHit(runtimePoleSession, polePrimary);
    runtimeTimers[0]();
} finally {
    Math.random = originalRandom;
}
const runtimePolePacket = runtimePoleSession.packets.find((packet) => packet?.[0] === 0x05);
assert(runtimePolePacket, 'a polearm swing should broadcast the C4 Attack packet');
assert.strictEqual(runtimePolePacket.readInt16LE(26), 1, 'a polearm swing should serialize its secondary target');
assert.strictEqual(runtimePolePacket.readInt32LE(32), 85, 'the first polearm secondary target should receive 85 percent damage');
assert.deepStrictEqual(runtimeDamage, [[polePrimary.fetchId(), 100], [poleSecondary.fetchId(), 85]], 'the polearm hit timer should damage both serialized targets');

const heavyDwarf = actor({ skills: [skill(231, 'Heavy Armor Mastery', 50, { passive: true })], armorKinds: ['Armor.Chain'] });
assert.strictEqual(EffectStats.add(heavyDwarf, 'pDefAdd'), 79.3, 'Heavy Armor Mastery level 50 should add sourced P.Def');

const weighted = {
    ...actor({ skills: [skill(150, 'Weight Limit', 3, { passive: true })] }),
    fetchClassId: () => 53,
    fetchCon: () => 30,
    fetchMen: () => 30,
    fetchStr: () => 30,
    fetchDex: () => 30,
    fetchInt: () => 30,
    fetchWit: () => 30,
    fetchMaxMp() { return this.maxMp; },
    fetchPAtk: () => 10,
    fetchMAtk: () => 10,
    fetchPDef: () => 10,
    fetchMDef: () => 10,
    fetchAccur: () => 0,
    fetchEvasion: () => 0,
    fetchCritical: () => 40,
    fetchAtkSpd: () => 300,
    fetchWalkSpd: () => 80,
    fetchRunSpd: () => 120,
    isSpellcaster: () => 0,
    setMaxHp(value) { this.maxHp = value; },
    setMaxMp(value) { this.maxMp = value; },
    setMaxLoad(value) { this.maxLoad = value; },
    setLoad(value) { this.load = value; },
    setCollectivePAtk(value) { this.collectivePAtk = value; },
    setCollectiveMAtk(value) { this.collectiveMAtk = value; },
    setCollectivePDef(value) { this.collectivePDef = value; },
    setCollectiveMDef(value) { this.collectiveMDef = value; },
    setCollectiveAccur(value) { this.collectiveAccur = value; },
    setCollectiveEvasion(value) { this.collectiveEvasion = value; },
    setCollectiveCritical(value) { this.collectiveCritical = value; },
    setCollectiveAtkSpd(value) { this.collectiveAtkSpd = value; },
    setCollectiveCastSpd(value) { this.collectiveCastSpd = value; },
    setCollectiveWalkSpd(value) { this.collectiveWalkSpd = value; },
    setCollectiveRunSpd(value) { this.collectiveRunSpd = value; }
};
Object.assign(weighted.backpack, {
    syncEquipmentItemSkills() {},
    fetchTotalArmorBonusMp: () => 0,
    fetchTotalLoad: () => 0,
    fetchTotalWeaponPAtk: () => 100,
    fetchTotalWeaponMAtk: () => 50,
    fetchTotalArmorPDef: () => 100,
    fetchTotalArmorMDef: () => 80,
    fetchTotalWeaponAccur: () => 5,
    fetchTotalArmorEvasion: () => 2,
    fetchTotalWeaponCritical: () => 40,
    fetchTotalWeaponAtkSpd: () => 300
});
calculateStats({}, weighted);
assert.strictEqual(weighted.maxLoad, Formulas.calcMaxLoad(30) * 4, 'Weight Limit should affect the actor calculated max load, not only semantic metadata');

assert.strictEqual(C4SkillRules.resolve({ selfId: 172, name: 'Create Item', level: 9 }).skillType, C4SkillRules.PASSIVE, 'Create Item should remain a passive recipe-level skill');
assert.strictEqual(C4SkillRules.resolve({ selfId: 194, name: 'Lucky', level: 1 }).skillType, C4SkillRules.PASSIVE, 'Lucky should remain passive');
assert.strictEqual(C4SkillRules.resolve({ selfId: 248, name: 'Crystallize', level: 5 }).skillType, C4SkillRules.PASSIVE, 'Crystallize should remain a passive grade-capability skill');
assert.strictEqual(C4SkillRules.resolve({ selfId: 1321, name: 'Dwarven Craft', level: 1 }).skillType, C4SkillRules.DUMMY, 'Dwarven Craft should use the recipe-book handler instead of combat fallback');

for (const [id, name] of [[13, 'Summon Siege Golem'], [25, 'Summon Mechanic Golem'], [299, 'Summon Wild Hog Cannon'], [301, 'Summon Big Boom']]) {
    assert.strictEqual(C4SkillRules.resolve({ selfId: id, name, level: 1 }).skillType, C4SkillRules.SUMMON, `${name} should reach the summon runtime`);
}
assert.strictEqual(C4SkillRules.resolve({ selfId: 60, name: 'Fake Death', level: 1 }).operateType, 'toggle', 'Fake Death should remain activatable');
for (const [id, name] of [[339, 'Parry Stance'], [340, 'Riposte Stance']]) {
    const toggleActor = actor();
    const stance = skill(id, name, 1, { spell: true });
    assert.strictEqual(stance.fetchSpell(), false, `${name} should use physical toggle timing`);
    ToggleSkills.handleRequest(session(toggleActor), toggleActor, stance);
    assert(EffectStore.list(toggleActor).some((effect) => effect.id === id), `${name} should activate as a maintained toggle`);
    ToggleSkills.handleRequest(session(toggleActor), toggleActor, stance);
}

const stunAttack = skill(100, 'Stun Attack', 15, { spell: true, distance: 40, buff: 9000 });
const hammerCrush = skill(260, 'Hammer Crush', 37, { spell: true, distance: 40, buff: 9000 });
for (const dwarfStun of [stunAttack, hammerCrush]) {
    const semantic = dwarfStun.fetchSemantic();
    assert.strictEqual(dwarfStun.fetchSpell(), false, `${dwarfStun.fetchName()} should be physical despite stale active data`);
    assert.strictEqual(semantic.durationMs, 9000, `${dwarfStun.fetchName()} should preserve the sourced nine-second stun`);
    assert.strictEqual(semantic.reuseTime, 13000, `${dwarfStun.fetchName()} should preserve the sourced reuse`);
    assert.strictEqual(semantic.magicLevel, dwarfStun.fetchSelfId() === 100 ? 36 : 74, `${dwarfStun.fetchName()} should preserve its final sourced magic level`);
    assert.strictEqual(new Attack().skillUseConditionFailure(actor({ weaponKind: 'Weapon.Sword' }), dwarfStun), 'Incorrect weapon.', `${dwarfStun.fetchName()} should require a blunt weapon`);
}

const earthquake = skill(347, 'Earthquake', 1, { spell: true, distance: 40, hp: 340, power: 4040 });
assert.strictEqual(earthquake.fetchSpell(), false, 'Earthquake should use physical cast timing');
assert.strictEqual(earthquake.fetchTargetKind(), 'enemy', 'Earthquake should damage enemies');
assert.strictEqual(earthquake.fetchSemantic().sourceTarget, 'aura', 'Earthquake should originate from the caster');
assert.strictEqual(earthquake.fetchSemantic().removeTarget, true, 'Earthquake should preserve its RemoveTarget effect');
assert.strictEqual(earthquake.fetchConsumedHp(), 340, 'Earthquake should consume the sourced 340 HP');
const auraCaster = actor();
let auraPrimary;
auraCaster.skillset.fetchSkill = () => earthquake;
auraCaster.attack.remoteHit = (_session, target) => { auraPrimary = target; };
skillExec(session(auraCaster), auraCaster, { selfId: 347 });
assert.strictEqual(auraPrimary, auraCaster, 'caster-centered Earthquake should execute without a selected NPC even though legacy data has range 40');

const quakeTarget = actor({ id: 1000001, destId: 12345 });
C4SkillEffects.execute(session(auraCaster), auraCaster, quakeTarget, earthquake, {
    magicSkill: false,
    rng: () => 0,
    attack: { prepareSkillDamage: () => 100, clearLoadedShot() {} }
});
assert.strictEqual(quakeTarget.fetchDestId(), undefined, 'Earthquake should remove every affected enemy target');

const emptyAuraCaster = actor({ weaponKind: 'Weapon.Pole' });
const emptyAuraSession = session(emptyAuraCaster);
const emptyAuraAttack = new Attack();
emptyAuraAttack.queueTimer = (callback) => callback();
emptyAuraAttack.resolveSkillTargets = () => [];
emptyAuraAttack.remoteHit(emptyAuraSession, emptyAuraCaster, earthquake);
assert.strictEqual(emptyAuraCaster.fetchMp(), 913, 'targetless Earthquake should still consume its sourced MP cost');
assert.strictEqual(emptyAuraCaster.fetchHp(), 660, 'targetless Earthquake should still consume its sourced HP cost');
assert.strictEqual(emptyAuraCaster.state.casts, false, 'targetless Earthquake should finish its cast normally');

const skillCritAttack = new Attack();
const skillCritCaster = actor({ weaponKind: 'Weapon.Pole', str: 40 });
const skillCritTarget = actor({ id: 1000009, pDef: 100 });
const normalQuakeDamage = skillCritAttack.prepareSkillDamage(skillCritCaster, skillCritTarget, earthquake, false, () => 1);
const criticalQuakeDamage = skillCritAttack.prepareSkillDamage(skillCritCaster, skillCritTarget, earthquake, false, () => 0);
assert.strictEqual(criticalQuakeDamage, normalQuakeDamage * 2, 'Earthquake physical skill critical should double final damage without melee critical-power modifiers');

const armorCrush = skill(362, 'Armor Crush', 1, { spell: true, distance: 40, hp: 254, power: 1973, buff: 9000 });
assert.strictEqual(armorCrush.fetchSpell(), false, 'Armor Crush should be a physical skill');
assert.strictEqual(armorCrush.fetchSkillType(), C4SkillRules.DAMAGE_EFFECT, 'Armor Crush should deal damage and apply a debuff');
assert.strictEqual(armorCrush.fetchConsumedHp(), 254, 'Armor Crush should consume the sourced 254 HP');
const crushed = actor({ id: 1000002 });
const crushOutcome = C4SkillEffects.execute(session(auraCaster), auraCaster, crushed, armorCrush, {
    magicSkill: false,
    rng: () => 0,
    attack: { prepareSkillDamage: () => 100, clearLoadedShot() {} }
});
assert.strictEqual(crushOutcome.damage, 100, 'Armor Crush should retain its physical damage component');
assert(EffectStore.hasDebuff(crushed, 'stun'), 'Armor Crush should apply the sourced stun');
assert.strictEqual(EffectStats.multiplier(crushed, 'pDefMul'), 0.7, 'Armor Crush should reduce P.Def by 30 percent');
assert.strictEqual(EffectStats.multiplier(crushed, 'mDefMul'), 0.7, 'Armor Crush should reduce M.Def by 30 percent');

const spoilReward = DataCache.npcRewards.find((entry) => entry.spoils?.some((group) => group.items?.length));
assert(spoilReward, 'the C4 reward cache should contain a spoilable NPC fixture');
const spoilTarget = {
    model: {},
    effects: {},
    fetchId: () => 1000003,
    fetchSelfId: () => spoilReward.selfId,
    fetchName: () => 'Spoil Target',
    fetchLevel: () => 76,
    fetchAttackable: () => true,
    dead: false,
    isDead() { return this.dead; },
    state: { fetchDead() { return spoilTarget.dead; } },
    enterCombatState() {}
};
const spoilCrush = skill(348, 'Spoil Crush', 1, { spell: true, distance: 40, power: 5 });
const spoilOutcome = C4SkillEffects.execute(session(auraCaster), auraCaster, spoilTarget, spoilCrush, {
    magicSkill: false,
    rng: () => 0,
    attack: { prepareSkillDamage: () => 5, clearLoadedShot() {} }
});
assert.strictEqual(spoilCrush.fetchSpell(), false, 'Spoil Crush should use physical cast timing');
assert.strictEqual(spoilOutcome.damage, 5, 'Spoil Crush should deal its sourced physical damage');
assert.strictEqual(spoilOutcome.spoilOnHit, true, 'Spoil Crush should defer its native extra SPOIL handler until after damage');
assert.strictEqual(spoilOutcome.spoiled, false, 'Spoil Crush effect preparation must not mark the target before damage lands');
assert.strictEqual(SpoilSweep.trySpoilCrush(session(auraCaster), auraCaster, spoilTarget, spoilCrush, () => 0.5), true, 'Spoil Crush should run its separate sourced spoil roll after damage');
assert.strictEqual(spoilTarget.model.spoil.spoilerId, auraCaster.fetchId(), 'Spoil Crush should attribute the spoil to its caster');

const killedBySpoilCrush = { ...spoilTarget, model: {}, dead: true };
killedBySpoilCrush.state = { fetchDead: () => killedBySpoilCrush.dead };
assert.strictEqual(SpoilSweep.trySpoilCrush(session(auraCaster), auraCaster, killedBySpoilCrush, spoilCrush, () => 0), false, 'a killing Spoil Crush must not spoil the corpse');

console.log('Dwarf class skill checks passed');
