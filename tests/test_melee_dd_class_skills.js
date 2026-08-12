const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const BotCombatUtility = invoke('GameServer/Bot/AI/BotCombatUtility');
const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const ChargeLifecycle = invoke('GameServer/Skills/ChargeLifecycle');
const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const NpcModel = invoke('GameServer/Model/Npc');
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
        distance: overrides.distance ?? 40,
        mp: overrides.mp ?? 0,
        hp: overrides.hp ?? 0,
        power: overrides.power ?? 1,
        hitTime: overrides.hitTime ?? 0,
        reuse: overrides.reuse ?? 0,
        buff: overrides.buff ?? 0
    });
}

function actor(overrides = {}) {
    const learnedSkills = overrides.skills || [];
    const state = {
        seated: overrides.seated === true,
        fetchSeated() { return this.seated; },
        setSeated(value) { this.seated = value; },
        fetchDead: () => false,
        inMotion: () => false,
        fetchWalkin: () => false,
        setHits() {},
        setCasts() {},
        setCombats() {}
    };
    const value = {
        effects: {},
        hp: overrides.hp ?? 1000,
        maxHp: overrides.maxHp ?? 1000,
        mp: overrides.mp ?? 1000,
        maxMp: overrides.maxMp ?? 1000,
        charges: overrides.charges ?? 0,
        skills: learnedSkills,
        state,
        fetchId: () => overrides.id ?? 2000001,
        fetchLevel: () => overrides.level ?? 78,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchHead: () => 0,
        fetchDex: () => 30,
        fetchHp() { return this.hp; },
        setHp(next) { this.hp = next; },
        fetchMaxHp() { return this.maxHp; },
        fetchMp() { return this.mp; },
        setMp(next) { this.mp = next; },
        fetchMaxMp() { return this.maxMp; },
        fetchCharges() { return this.charges; },
        setCharges(next) { this.charges = next; },
        fetchCollectivePAtk: () => 100,
        fetchCollectivePDef: () => 100,
        fetchCollectiveMDef: () => 100,
        fetchPassiveSkills: () => [],
        skillset: { skills: learnedSkills, fetchSkills: () => learnedSkills },
        canUseSkill: () => true,
        statusUpdateVitals() {},
        automation: { abortAll() {} },
        attack: { clearTimers() {}, resetQueuedEvent() {} },
        backpack: {
            fetchTotalWeaponKind: () => overrides.weaponKind || 'Weapon.DualFist',
            fetchTotalWeaponPAtkRnd: () => 0,
            fetchTotalShieldRate: () => 0,
            fetchTotalShieldPDef: () => 0,
            fetchEquippedArmors: () => []
        }
    };
    return value;
}

function session(value) {
    return {
        actor: value,
        dataSendToMe() {},
        dataSendToMeAndOthers() {}
    };
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
    const classIds = [0, 1, 2, 3, 44, 45, 46, 47, 48, 88, 89, 113, 114];
    const trees = skillTree.filter((tree) => classIds.includes(tree.classId));
    assert.strictEqual(trees.length, classIds.length, 'every C4 melee-DD profession should have a skill tree');
    const ids = new Set(trees.flatMap((tree) => tree.skills.map((entry) => entry.selfId)));
    for (const id of [5, 8, 9, 17, 35, 50, 54, 210, 222, 226, 257, 261, 284, 290, 293, 295, 319, 345, 346, 359, 360, 361, 362]) {
        assert(ids.has(id), `melee-DD class trees should expose skill ${id}`);
    }

    DataCache.init();
    assert.strictEqual(DataCache.skills.find((entry) => entry.selfId === 210).levels.length, 45, 'Fist Mastery should materialize all 45 sourced levels');
    assert.strictEqual(DataCache.skills.find((entry) => entry.selfId === 257).levels.length, 45, 'Sword/Blunt Mastery should materialize all 45 sourced levels');

    const passives = actor({
        skills: [
            skill(210, 'Fist Mastery', 45, { passive: true }),
            skill(290, 'Final Frenzy', 14, { passive: true }),
            skill(295, 'Iron Body', 1, { passive: true }),
            skill(319, 'Agile Movement', 2, { passive: true })
        ]
    });
    assert.strictEqual(EffectStats.add(passives, 'pAtkAdd'), 129.3, 'Fist Mastery should grant sourced max-level P.Atk');
    passives.backpack.fetchTotalWeaponKind = () => 'Weapon.Sword';
    assert.strictEqual(EffectStats.add(passives, 'pAtkAdd'), 0, 'Fist Mastery should not apply while a non-fist weapon is equipped');
    assert.strictEqual(C4SkillRules.resolve({ selfId: 290 }).skillType, C4SkillRules.PASSIVE, 'Final Frenzy should remain passive');
    assert.strictEqual(C4SkillRules.resolve({ selfId: 293 }).skillType, C4SkillRules.PASSIVE, 'Two-handed Weapon Mastery should remain passive');
    assert.strictEqual(C4SkillRules.resolve({ selfId: 295 }).skillType, C4SkillRules.PASSIVE, 'Iron Body should remain passive');
    assert.strictEqual(C4SkillRules.resolve({ selfId: 319 }).skillType, C4SkillRules.PASSIVE, 'Agile Movement should remain passive');

    const attack = new Attack();
    const spender = skill(261, 'Triple Sonic Slash');
    const gladiator = actor({ weaponKind: 'Weapon.Dual', charges: 2 });
    assert.strictEqual(attack.skillUseConditionFailure(gladiator, spender), 'Not enough charges.', 'Triple Sonic Slash should reject fewer than three charges');
    gladiator.setCharges(3);
    assert.strictEqual(attack.skillUseConditionFailure(gladiator, spender), null, 'Triple Sonic Slash should accept three charges');
    assert.strictEqual(attack.consumeSkillCharges(session(gladiator), gladiator, spender), true, 'charge consumption should succeed once per cast');
    assert.strictEqual(gladiator.fetchCharges(), 0, 'Triple Sonic Slash should consume exactly three charges');
    const chargedOutcome = C4SkillEffects.execute(session(gladiator), gladiator, actor({ id: 1000003 }), spender, {
        magicSkill: false,
        chargeCount: 7,
        attack: { prepareSkillDamage: () => 100, clearLoadedShot() {} }
    });
    assert.strictEqual(chargedOutcome.damage, 221, 'charged damage should use the sourced 0.8 + 0.201 x charges multiplier');

    const tyrant = actor({ charges: 6 });
    const forceRage = skill(346, 'Force Rage', 1, { power: 1 });
    const rageOutcome = C4SkillEffects.execute(session(tyrant), tyrant, actor({ id: 1000001 }), forceRage, {
        magicSkill: false,
        attack: { prepareSkillDamage: () => 100, clearLoadedShot() {} }
    });
    assert.strictEqual(forceRage.fetchSemantic().requires.charges, undefined, 'Force Rage should not require an existing charge');
    assert.strictEqual(rageOutcome.charges, 7, 'Force Rage should generate one charge when its PDAM use resolves');
    assert.strictEqual(tyrant.fetchCharges(), 7, 'Force Rage should cap at seven charges');

    const timedCharges = actor();
    ChargeLifecycle.increase(session(timedCharges), timedCharges, 1, 7);
    const firstChargeDeadline = timedCharges.chargeExpiresAt;
    assert(firstChargeDeadline - Date.now() > 590000, 'the first charge should start the sourced ten-minute expiry');
    ChargeLifecycle.increase(session(timedCharges), timedCharges, 1, 7);
    assert.strictEqual(timedCharges.chargeExpiresAt, firstChargeDeadline, 'adding charges should not refresh the original expiry deadline');
    ChargeLifecycle.clear(session(timedCharges), timedCharges);
    assert.strictEqual(timedCharges.fetchCharges(), 0, 'clearing the charge lifecycle should remove the entire stack');
    assert.strictEqual(timedCharges.chargeExpiryTimer, undefined, 'clearing charges should cancel their expiry timer');

    const chargingBot = actor({
        weaponKind: 'Weapon.DualFist',
        charges: 0,
        skills: [skill(50, 'Focus Force', 7), skill(54, 'Force Blaster', 1, { mp: 10, distance: 600, power: 100 })]
    });
    assert.strictEqual(BotCombatUtility.evaluate(chargingBot, actor({ id: 1000002 }), chargingBot.skills[1], 'dps'), null, 'hot bots should not select a spender without charges');
    assert.strictEqual(BotCombatUtility.selectChargeSkill(chargingBot, 'dps').fetchSelfId(), 50, 'hot bots should use Focus Force before a charged attack');
    chargingBot.setCharges(1);
    assert.strictEqual(BotCombatUtility.selectChargeSkill(chargingBot, 'dps'), null, 'hot bots should stop charging once the learned spender is usable');

    const fistFuryActor = actor({ hp: 20, maxHp: 100, mp: 100 });
    const fistFury = skill(222, 'Fist Fury');
    fistFury.fetchSemantic().toggleIntervalMs = 10;
    assert.strictEqual(ToggleSkills.activate(session(fistFuryActor), fistFuryActor, fistFury, 'fist_fury'), true, 'Fist Fury should activate with dual fists');
    assert.strictEqual(fistFuryActor.fetchMp(), 92, 'Fist Fury should consume sourced activation MP');
    assert.strictEqual(EffectStats.multiplier(fistFuryActor, 'pAtkSpdMul'), 1.25, 'Fist Fury should grant sourced attack-speed multiplier');
    await wait(15);
    assert.strictEqual(fistFuryActor.fetchHp(), 7, 'Fist Fury should drain sourced 13 HP per second');
    await wait(15);
    assert.strictEqual(fistFuryActor.fetchHp(), 7, 'Fist Fury should stop before its HP drain becomes lethal');
    assert.strictEqual(EffectStore.list(fistFuryActor).length, 0, 'Fist Fury should remove itself before a lethal tick');

    const weaponSwapActor = actor({ hp: 100, maxHp: 100, mp: 100 });
    assert.strictEqual(ToggleSkills.activate(session(weaponSwapActor), weaponSwapActor, fistFury, 'fist_fury'), true, 'Fist Fury should activate while fists are equipped');
    weaponSwapActor.backpack.fetchTotalWeaponKind = () => 'Weapon.Sword';
    ToggleSkills.syncEquipment(session(weaponSwapActor), weaponSwapActor);
    assert.strictEqual(EffectStore.list(weaponSwapActor).some((effect) => effect.key === 'fist_fury'), false, 'Fist Fury should turn off immediately after swapping away from fists');
    assert.strictEqual(EffectStats.multiplier(weaponSwapActor, 'pAtkSpdMul'), 1, 'an invalidated Fist Fury should stop granting attack speed');

    const healthy = actor({ hp: 100, maxHp: 100, mp: 100 });
    const relax = skill(226, 'Relax');
    assert.strictEqual(ToggleSkills.activate(session(healthy), healthy, relax, 'relax'), false, 'Relax should not activate at full HP');
    const wounded = actor({ hp: 50, maxHp: 100, mp: 100 });
    assert.strictEqual(ToggleSkills.activate(session(wounded), wounded, relax, 'relax'), true, 'Relax should activate while wounded');
    assert.strictEqual(wounded.state.fetchSeated(), true, 'Relax should sit its caster');
    assert.strictEqual(wounded.silentMoving, undefined, 'Relax should not incorrectly enable silent movement');
    assert.strictEqual(EffectStats.add(wounded, 'regHpAdd'), 5, 'Relax should grant sourced seated HP regeneration');
    ToggleSkills.deactivate(session(wounded), wounded, 'relax');

    const hunter = actor();
    const eye = skill(359, 'Eye of Hunter', 1, { spell: true });
    assert.strictEqual(eye.fetchSpell(), true, 'Eye of Hunter should remain a magical C4 buff');
    C4SkillEffects.execute(session(hunter), hunter, hunter, eye, { magicSkill: false, attack: { clearLoadedShot() {} } });
    assert.strictEqual(EffectStats.multiplier(hunter, 'pAtk-insects'), 1.5, 'Eye of Hunter should expose sourced insect damage');
    assert.strictEqual(EffectStats.multiplier(hunter, 'pAtk-plants'), 1.5, 'Eye of Hunter should expose sourced plant damage');
    assert.strictEqual(EffectStats.multiplier(hunter, 'pAtk-animals'), 1.5, 'Eye of Hunter should expose sourced animal damage');
    assert.strictEqual(Attack.physicalRaceModifier(hunter, { fetchRace: () => 'insect' }), 1.5, 'Eye of Hunter should multiply physical damage against insects');
    assert.strictEqual(Attack.physicalRaceModifier(hunter, { fetchRace: () => 'beast' }), 1, 'Eye of Hunter should not multiply damage against unrelated beasts');
    const legacyCombatNpcs = require('../data/Npcs/npcs.json')
        .filter((npc) => ['Monster', 'Boss'].includes(npc.template?.kind));
    assert.strictEqual(legacyCombatNpcs.length, 1169, 'legacy combat NPC fixture count should remain explicit');
    assert(legacyCombatNpcs.every((npc) => typeof npc.traits?.race === 'string'), 'every legacy combat NPC should retain its sourced race');
    const gremlin = new NpcModel(utils.crushOb(legacyCombatNpcs.find((npc) => Number(npc.selfId) === 1)));
    assert.strictEqual(gremlin.fetchRace(), 'fairy', 'legacy NPC models should expose their sourced race to weakness skills');
    const slayer = actor();
    const slayerEye = skill(360, 'Eye of Slayer', 1, { spell: true });
    C4SkillEffects.execute(session(slayer), slayer, slayer, slayerEye, { magicSkill: false, attack: { clearLoadedShot() {} } });
    for (const race of ['beast', 'construct', 'dragon', 'giant']) {
        assert.strictEqual(Attack.physicalRaceModifier(slayer, { fetchRace: () => race }), 1.5, `Eye of Slayer should multiply physical damage against ${race}`);
    }
    C4SkillEffects.execute(session(hunter), hunter, hunter, slayerEye, { magicSkill: true, attack: { clearLoadedShot() {} } });
    assert.strictEqual(EffectStore.list(hunter).filter((effect) => effect.category === 'detect_weakness').length, 1, 'Eye buffs should share the sourced detect-weakness stack slot');
    const shockBlast = C4SkillRules.resolve({ selfId: 361 });
    assert.deepStrictEqual(
        [shockBlast.sourceTarget, shockBlast.radius, shockBlast.castRange, shockBlast.effectRange, shockBlast.power, shockBlast.hpConsume, shockBlast.reuseTime],
        ['area', 150, 500, 1000, 1973, 254, 30000],
        'Shock Blast should retain its sourced polearm area, cost, power and reuse semantics'
    );
    assert.deepStrictEqual(shockBlast.stats, { pDefMul: 0.7, mDefMul: 0.7 }, 'Shock Blast should apply both sourced defense debuffs');

    console.log('Melee DD class skill checks passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
