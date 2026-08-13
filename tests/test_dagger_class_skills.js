const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const DataCache = invoke('GameServer/DataCache');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const Formulas = invoke('GameServer/Formulas');
const NpcAggro = invoke('GameServer/Npc/NpcAggro');
const SkillModel = invoke('GameServer/Model/Skill');
const ToggleSkills = invoke('GameServer/Skills/ToggleSkills');
const attackRequest = invoke('GameServer/Actor/Generics/AttackRequest');
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
        hp: 0,
        power: overrides.power ?? 1,
        hitTime: overrides.hitTime ?? 0,
        reuse: overrides.reuse ?? 0,
        buff: overrides.buff ?? 0
    });
}

function passiveActor({ skills = [], weaponKind = 'Weapon.Knife', armorKind = 'Armor.Leather', armorKinds = null, moving = false, walking = false, seated = false } = {}) {
    return {
        effects: {},
        skillset: { fetchSkills: () => skills },
        fetchPassiveSkills: () => [],
        state: {
            inMotion: () => moving,
            fetchWalkin: () => walking,
            fetchSeated: () => seated
        },
        backpack: {
            fetchTotalWeaponKind: () => weaponKind,
            fetchEquippedArmors: () => (armorKinds || (armorKind ? [armorKind] : []))
                .map((kind) => ({ fetchKind: () => kind }))
        }
    };
}

function toggleActor(mp = 500) {
    return {
        effects: {},
        mp,
        fakeDeath: false,
        silentMoving: false,
        fetchId: () => 2000001,
        fetchLocX: () => 100,
        fetchLocY: () => 200,
        fetchLocZ: () => 300,
        fetchMp() { return this.mp; },
        setMp(value) { this.mp = value; },
        statusUpdateVitals() {},
        automation: { abortAll() {} },
        attack: { clearTimers() {}, resetQueuedEvent() {} },
        state: {
            seated: false,
            fetchDead: () => false,
            fetchSeated() { return this.seated; },
            setSeated(value) { this.seated = value; },
            setHits() {},
            setCasts() {},
            setCombats() {},
            setTowards() {}
        }
    };
}

function session(actor) {
    return {
        actor,
        packets: [],
        dataSendToMe(packet) { this.packets.push(packet); },
        dataSendToMeAndOthers(packet) { this.packets.push(packet); }
    };
}

const daggerClassIds = [7, 8, 22, 23, 35, 36, 93, 101, 108];
const daggerTrees = skillTree.filter((tree) => daggerClassIds.includes(tree.classId));
assert.strictEqual(daggerTrees.length, daggerClassIds.length, 'every C4 dagger class must have a skill tree');
const daggerSkillIds = new Set(daggerTrees.flatMap((tree) => tree.skills.map((entry) => entry.selfId)));
for (const id of [16, 30, 60, 209, 221, 233, 256, 263, 296, 312, 321, 344, 355, 356, 357, 358]) {
    assert(daggerSkillIds.has(id), `dagger class trees should expose skill ${id}`);
}

for (const [id, initialMp, drain, interval] of [
    [60, 200, 35, 5000],
    [221, 7, 7, 5000],
    [256, 1, 0.2, 3000],
    [296, 9, 6, 3000],
    [312, 4, 0.4, 3000]
]) {
    const semantic = C4SkillRules.resolve({ selfId: id, level: 1 });
    assert.strictEqual(semantic.operateType, 'toggle', `skill ${id} should use toggle lifecycle`);
    assert.strictEqual(semantic.mpInitialConsume, initialMp, `skill ${id} should use sourced activation MP`);
    assert.strictEqual(semantic.toggleMpConsume, drain, `skill ${id} should use sourced periodic MP`);
    assert.strictEqual(semantic.toggleIntervalMs, interval, `skill ${id} should use sourced drain interval`);
}
assert.strictEqual(C4SkillRules.resolve({ selfId: 239, name: 'Expertise C', level: 2 }).skillType, C4SkillRules.PASSIVE, 'Expertise should remain an automatic passive rather than an attack');

const fakeActor = toggleActor();
const fakeSession = session(fakeActor);
const fakeDeath = skill(60, 'Fake Death');
assert.strictEqual(ToggleSkills.handleRequest(fakeSession, fakeActor, fakeDeath), true);
assert.strictEqual(fakeActor.fetchMp(), 300, 'Fake Death should consume 200 MP on activation');
assert.strictEqual(fakeActor.fakeDeath, true, 'Fake Death should enter the disabled fake-death state');
assert.strictEqual(EffectRestrictions.canMove(fakeActor), false, 'Fake Death should block movement');
assert.strictEqual(EffectRestrictions.canAttack(fakeActor), false, 'Fake Death should block attacks');
assert.strictEqual(NpcAggro.canEngage({ fetchHostile: () => true, state: { fetchDead: () => false, fetchCombats: () => false }, aggroEligibleAt: 0 }, fakeActor, Date.now()), false, 'hostile NPCs should ignore fake-dead actors');
ToggleSkills.handleRequest(fakeSession, fakeActor, fakeDeath);
assert.strictEqual(fakeActor.fakeDeath, false, 'using Fake Death again should restore the actor');
assert(fakeSession.packets.filter((packet) => packet[0] === 0x2f).length >= 2, 'Fake Death should broadcast native start and stop wait types');

const silentActor = toggleActor(100);
const silentMove = skill(221, 'Silent Move');
ToggleSkills.handleRequest(session(silentActor), silentActor, silentMove);
assert.strictEqual(silentActor.silentMoving, true, 'Silent Move should hide the actor from ordinary NPC aggro');
assert.strictEqual(EffectStats.multiplier(silentActor, 'runSpdMul'), 0.6, 'Silent Move should apply its C4 speed penalty');
ToggleSkills.handleRequest(session(silentActor), silentActor, silentMove);
assert.strictEqual(silentActor.silentMoving, false, 'turning Silent Move off should clear stealth state');

const passives = passiveActor({
    moving: true,
    skills: [
        skill(137, 'Critical Chance', 3, { passive: true }),
        skill(168, 'Boost Attack Speed', 3, { passive: true }),
        skill(169, 'Quick Step', 2, { passive: true }),
        skill(171, 'Esprit', 8, { passive: true }),
        skill(173, 'Acrobat', 2, { passive: true }),
        skill(193, 'Critical Power', 6, { passive: true }),
        skill(198, 'Boost Evasion', 3, { passive: true }),
        skill(209, 'Dagger Mastery', 45, { passive: true }),
        skill(225, 'Acrobatic Move', 3, { passive: true }),
        skill(233, 'Light Armor Mastery', 47, { passive: true })
    ]
});
assert.strictEqual(EffectStats.multiplier(passives, 'pCritRateMul'), 1.4, 'Critical Chance should apply at max C4 level');
assert.strictEqual(EffectStats.multiplier(passives, 'pAtkSpdMul'), 1.1, 'Boost Attack Speed should apply at max C4 level');
assert.strictEqual(EffectStats.add(passives, 'runSpdAdd'), 11, 'Quick Step should add sourced run speed');
assert.strictEqual(EffectStats.add(passives, 'regHpAdd'), 6, 'Esprit should apply only while moving');
assert.strictEqual(EffectStats.add(passives, 'fallAdd'), -100, 'Acrobat should reduce the fall term before percentage modifiers');
assert.strictEqual(EffectStats.add(passives, 'pCritDamageAdd'), 384, 'Critical Power should feed blow and melee critical damage');
assert.strictEqual(EffectStats.add(passives, 'pEvasionRateAdd'), 17, 'evasion passives should stack while moving in light armor');
assert(Math.abs(EffectStats.add(passives, 'pAtkAdd') - 112.8) < 0.001, 'Dagger Mastery should require and enhance knives');
assert(Math.abs(EffectStats.add(passives, 'pDefAdd') - 65.6) < 0.001, 'Light Armor Mastery should apply sourced max-level P.Def');

const walkingPassives = passiveActor({
    moving: true,
    walking: true,
    skills: [skill(171, 'Esprit', 8, { passive: true }), skill(225, 'Acrobatic Move', 3, { passive: true })]
});
assert.strictEqual(EffectStats.add(walkingPassives, 'regHpAdd'), 0, 'Esprit must not activate while walking');
assert.strictEqual(EffectStats.add(walkingPassives, 'pEvasionRateAdd'), 0, 'Acrobatic Move must not activate while walking');

const mixedArmor = passiveActor({
    armorKinds: ['Armor.Leather', 'Armor.Chain'],
    skills: [skill(233, 'Light Armor Mastery', 47, { passive: true })]
});
assert.strictEqual(EffectStats.add(mixedArmor, 'pDefAdd'), 0, 'Light Armor Mastery must not activate with mixed heavy armor');

const wrongEquipment = passiveActor({
    weaponKind: 'Weapon.Sword',
    armorKind: 'Armor.Heavy',
    skills: [skill(209, 'Dagger Mastery', 45, { passive: true }), skill(233, 'Light Armor Mastery', 47, { passive: true })]
});
assert.strictEqual(EffectStats.add(wrongEquipment, 'pAtkAdd'), 0, 'Dagger Mastery must not affect swords');
assert.strictEqual(EffectStats.add(wrongEquipment, 'pDefAdd'), 0, 'Light Armor Mastery must not affect heavy armor');

const bowActor = passiveActor({ weaponKind: 'Weapon.Bow', skills: [skill(113, 'Long Shot', 2, { passive: true })] });
assert.strictEqual(attackRequest.fetchNormalAttackRange(bowActor, {}), 1100, 'Long Shot should extend server-side bow range to 1100');

DataCache.init();
assert(DataCache.skills.find((entry) => entry.selfId === 209).levels.some((entry) => entry.level === 45), 'Dagger Mastery should materialize all 45 C4 levels');
assert(DataCache.skills.find((entry) => entry.selfId === 233).levels.some((entry) => entry.level === 47), 'Light Armor Mastery should materialize all 47 C4 levels');

const focusActor = passiveActor();
const focusChance = C4SkillRules.resolve({ selfId: 356, level: 1 });
EffectStore.apply(focusActor, { key: focusChance.effect, id: 356, level: 1, durationMs: 120000, stats: focusChance.stats, situationalStats: focusChance.situationalStats });
assert.strictEqual(EffectStats.situationalMultiplier(focusActor, 'pCritRateMul', { front: true }), 0.7, 'Focus Chance should lower front critical rate');
assert.strictEqual(EffectStats.situationalMultiplier(focusActor, 'blowRateMul', {}), 1.3, 'Focus Chance should raise side blow rate');
assert.strictEqual(EffectStats.situationalMultiplier(focusActor, 'blowRateMul', { behind: true }), 1.6, 'Focus Chance should raise rear blow rate');
focusActor.backpack.fetchTotalWeaponKind = () => 'Weapon.Bow';
assert.strictEqual(EffectStats.situationalMultiplier(focusActor, 'pCritRateMul', { behind: true }), 1, 'Focus Chance critical modifier must stop after switching away from a dagger');
assert.strictEqual(EffectStats.situationalMultiplier(focusActor, 'blowRateMul', { behind: true }), 1.6, 'Focus Chance blow-rate modifier remains positional in the C4 source');
focusActor.backpack.fetchTotalWeaponKind = () => 'Weapon.Knife';
const focusDeath = C4SkillRules.resolve({ selfId: 355, level: 1 });
EffectStore.apply(focusActor, { key: focusDeath.effect, id: 355, level: 1, durationMs: 120000, stats: focusDeath.stats, situationalStats: focusDeath.situationalStats });
assert.strictEqual(EffectStore.list(focusActor).length, 1, 'dagger Focus skills should replace one another in the shared C4 stack slot');
assert.strictEqual(EffectStore.list(focusActor)[0].id, 355, 'the latest dagger Focus should own the shared slot');

const blowActor = passiveActor({ skills: [skill(193, 'Critical Power', 6, { passive: true })] });
blowActor.fetchCollectivePAtk = () => 100;
blowActor.fetchDex = () => 20;
blowActor.soulshotLoaded = false;
blowActor.backpack.fetchTotalWeaponPAtkRnd = () => 0;
const blowTarget = {
    fetchCollectivePDef: () => 100,
    fetchShieldRate: () => 0,
    fetchDex: () => 20,
    fetchMaxHp: () => 1000,
    fetchHp: () => 1000
};
const attack = new Attack();
attack.isBehindTarget = () => true;
attack.isFacing = () => false;
const backstab = skill(30, 'Backstab', 37, { power: 2752, distance: 40 });
assert(attack.prepareSkillDamage(blowActor, blowTarget, backstab, false, () => 0) > Formulas.calcPhysicalDamage(100, 0, 100, 2752), 'blow damage should consume critical-power amplification');
assert.strictEqual(Formulas.calcBlowDamage(100, 10, 100, 100, { rng: () => 1 }), 150, 'blow weapon randomness should add at most the absolute pAtkRnd value');

const blindingActor = { ...blowActor, effects: {} };
const blinding = skill(321, 'Blinding Blow', 1, { power: 2723, distance: 40, buff: 15000 });
const missedBlinding = C4SkillEffects.execute(session(blindingActor), blindingActor, blowTarget, blinding, {
    magicSkill: false,
    rng: () => 0.99,
    attack: { isBehindTarget: () => false, isFacing: () => true, clearLoadedShot() {} }
});
assert.strictEqual(missedBlinding.missed, true, 'Blinding Blow should retain the native blow success roll');
assert.strictEqual(EffectStats.add(blindingActor, 'runSpdAdd'), 40, 'Blinding Blow should apply its self speed effect even when the blow misses');

const bluffTarget = {
    effects: {},
    head: 1000,
    aborted: false,
    fetchId: () => 1000001,
    fetchLevel: () => 77,
    fetchCollectiveMDef: () => 100,
    fetchDestId: () => 2000001,
    fetchHead() { return this.head; },
    setHead(value) { this.head = value; },
    abortCombatState() { this.aborted = true; }
};
const bluffActor = { ...blowActor, fetchId: () => 2000001, fetchLevel: () => 77, fetchHead: () => 54321, fetchCollectiveMAtk: () => 100 };
const bluff = skill(358, 'Bluff', 1, { distance: 40, power: 90, buff: 9000 });
const bluffOutcome = C4SkillEffects.execute(session(bluffActor), bluffActor, bluffTarget, bluff, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(bluffOutcome.aggroReduced, true, 'Bluff should drop the target aggression toward the caster');
assert.strictEqual(bluffTarget.aborted, true, 'Bluff should disengage an NPC currently targeting the caster');
assert.strictEqual(bluffTarget.fetchHead(), bluffActor.fetchHead(), 'Bluff should copy the caster heading');
assert(EffectStore.hasDebuff(bluffTarget, 'stun'), 'Bluff should apply its sourced stun effect');

const partyMob = {
    effects: {},
    aborted: false,
    fetchId: () => 1000002,
    fetchLevel: () => 60,
    fetchCollectiveMDef: () => 100,
    fetchDestId: () => 2000099,
    abortCombatState() { this.aborted = true; }
};
const veil = skill(106, 'Veil', 1, { distance: 500 });
C4SkillEffects.execute(session(bluffActor), bluffActor, partyMob, veil, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(partyMob.aborted, true, 'AGGRO_REMOVE should clear a mob attacking another party member');

console.log('Dagger class skill checks passed');
