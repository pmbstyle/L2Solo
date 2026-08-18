const assert = require('assert');

require('../src/Global');

const BotAI = invoke('GameServer/Bot/BotAI');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const SummonerTactics = invoke('GameServer/Bot/AI/SummonerTactics');

function skill(selfId, options = {}) {
    return {
        selfId,
        fetchSelfId: () => selfId,
        fetchName: () => options.name || `skill_${selfId}`,
        fetchConsumedMp: () => options.mp ?? 5,
        fetchPassive: () => false,
        fetchSemantic: () => options.semantic || {},
        fetchSkillType: () => options.type || C4SkillRules.DAMAGE,
        fetchTargetKind: () => options.target || 'enemy',
        fetchDistance: () => options.range ?? 600,
        fetchPower: () => options.power ?? 20,
        fetchSpell: () => options.spell === true
    };
}

function bot(classId, ownedSkills = [], mp = 100, weaponKind = '', hp = 100, maxHp = 100) {
    return {
        fetchClassId: () => classId,
        fetchHp: () => hp,
        fetchMaxHp: () => maxHp,
        fetchMp: () => mp,
        fetchMaxMp: () => 100,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        skillset: {
            skills: ownedSkills,
            fetchSkill(selfId) {
                return this.skills.find((entry) => entry.selfId === selfId) || null;
            }
        },
        backpack: {
            fetchTotalWeaponKind: () => weaponKind,
            fetchEquippedArmors: () => []
        }
    };
}

function npc(id = 1001) {
    return {
        fetchId: () => id,
        fetchLocX: () => 400,
        fetchLocY: () => 0
    };
}

function generics() {
    return {
        skills: [],
        attacks: [],
        skillExec(_session, _bot, data) {
            this.skills.push(data);
        },
        attackExec(_session, _bot, data) {
            this.attacks.push(data);
        }
    };
}

const originalRandom = Math.random;

try {
    Math.random = () => 0;

    const mage = bot(10, []);
    const mageGenerics = generics();
    BotAI.executeCombat({}, mage, npc(1101), mageGenerics);
    assert.strictEqual(mage.skillset.skills.length, 0, 'mage should not invent Wind Strike when it is not learned');
    assert.strictEqual(mageGenerics.skills.length, 0, 'mage without learned nuke should not cast an invented skill');
    assert.strictEqual(mageGenerics.attacks.length, 1, 'mage without learned nuke should fall back to a normal attack');

    const archer = bot(9, [skill(56, { mp: 5, range: 700, power: 24, semantic: { requires: { weaponsAllowed: 32 } } })], 20, 'Weapon.Bow');
    const archerGenerics = generics();
    BotAI.executeCombat({}, archer, npc(1102), archerGenerics);
    assert.deepStrictEqual(archerGenerics.skills[0], { id: 1102, selfId: 56, ctrl: true });
    assert.strictEqual(archerGenerics.attacks.length, 0, 'archer with learned Power Shot should cast it before ranged attack fallback');

    const bowWithMeleeSkill = bot(9, [skill(3, { name: 'Power Strike', mp: 5, range: 50, power: 500 })], 100, 'Weapon.Bow');
    const bowWithMeleeSkillGenerics = generics();
    BotAI.executeCombat({}, bowWithMeleeSkill, npc(11021), bowWithMeleeSkillGenerics);
    assert.strictEqual(bowWithMeleeSkillGenerics.skills.length, 0, 'a bow user must exclude short-range offensive skills from its rotation');
    assert.deepStrictEqual(
        bowWithMeleeSkillGenerics.attacks[0],
        { id: 11021, ctrl: true, range: 700 },
        'a bow user without an available ranged skill must keep its normal attack at bow range'
    );

    const bowWithMixedSkills = bot(9, [
        skill(3, { name: 'Power Strike', mp: 5, range: 50, power: 500 }),
        skill(56, { name: 'Power Shot', mp: 5, range: 700, power: 24, semantic: { requires: { weaponsAllowed: 32 } } })
    ], 100, 'Weapon.Bow');
    const bowWithMixedSkillsGenerics = generics();
    BotAI.executeCombat({}, bowWithMixedSkills, npc(11022), bowWithMixedSkillsGenerics);
    assert.strictEqual(bowWithMixedSkillsGenerics.skills[0].selfId, 56, 'a bow user must choose its ranged shot even when a stronger short-range skill is learned');

    const fatalCounter = skill(314, { name: 'Fatal Counter', mp: 5, range: 900, power: 2908, type: C4SkillRules.FATAL });
    const powerShot = skill(56, { name: 'Power Shot', mp: 5, range: 700, power: 500, semantic: { requires: { weaponsAllowed: 32 } } });
    const fullHpFatalDecision = invoke('GameServer/Bot/AI/BotCombatUtility').select(
        bot(37, [fatalCounter, powerShot], 100, 'Weapon.Bow', 100, 100),
        npc(11023),
        'archer'
    );
    assert.strictEqual(fullHpFatalDecision.skill.fetchSelfId(), 56, 'a full-HP archer should not score zero-power Fatal Counter above an ordinary shot');
    const woundedFatalDecision = invoke('GameServer/Bot/AI/BotCombatUtility').select(
        bot(37, [fatalCounter, powerShot], 100, 'Weapon.Bow', 10, 100),
        npc(11024),
        'archer'
    );
    assert.strictEqual(woundedFatalDecision.skill.fetchSelfId(), 314, 'a wounded archer should prefer Fatal Counter after its missing-HP power becomes stronger');

    const swordFighter = bot(18, [
        skill(56, { name: 'Power Shot', mp: 5, range: 700, power: 90, semantic: { requires: { weaponsAllowed: 32 } } }),
        skill(3, { name: 'Power Strike', mp: 5, range: 40, power: 30 })
    ], 100, 'Weapon.Sword');
    const swordFighterGenerics = generics();
    BotAI.executeCombat({}, swordFighter, npc(1111), swordFighterGenerics);
    assert.strictEqual(swordFighterGenerics.skills[0].selfId, 3, 'a sword fighter must not prepare Power Shot and should use its valid melee skill');

    const cooldownFighter = bot(0, [skill(3, { name: 'Power Strike', mp: 5, range: 40, power: 30 })], 100, 'Weapon.Sword');
    cooldownFighter.canUseSkill = () => false;
    const cooldownFighterGenerics = generics();
    BotAI.executeCombat({}, cooldownFighter, npc(1113), cooldownFighterGenerics);
    assert.strictEqual(cooldownFighterGenerics.skills.length, 0, 'a melee skill on reuse must not be selected again');
    assert.strictEqual(cooldownFighterGenerics.attacks.length, 1, 'a melee bot must use its normal attack while its offensive skill is on reuse');

    const fighter = bot(0, [], 20);
    const fighterGenerics = generics();
    BotAI.executeCombat({}, fighter, npc(1103), fighterGenerics);
    assert.strictEqual(fighter.skillset.skills.length, 0, 'fighter should not invent Power Strike when it is not learned');
    assert.strictEqual(fighterGenerics.skills.length, 0);
    assert.strictEqual(fighterGenerics.attacks.length, 1);

    const utilityMage = bot(10, [
        skill(1177, { name: 'Wind Strike', mp: 8, power: 12, spell: true }),
        skill(1234, { name: 'Strong Nuke', mp: 12, power: 80, spell: true })
    ], 100);
    const utilityGenerics = generics();
    const utilitySession = {};
    BotAI.executeCombat(utilitySession, utilityMage, npc(1104), utilityGenerics);
    assert.strictEqual(utilityGenerics.skills[0].selfId, 1234, 'mage should choose the stronger learned offensive spell');
    assert.strictEqual(utilitySession.lastCombatDecision.skillId, 1234, 'combat choice should be observable');

    const summon = skill(1276, {
        name: 'Summon Kai the Cat',
        mp: 70,
        type: C4SkillRules.SUMMON,
        target: 'self',
        spell: true
    });
    summon.fetchSummonNpcId = () => 12477;
    summon.fetchSummonIsCubic = () => false;
    const summoner = bot(14, [summon], 100);
    summoner.fetchId = () => 11040;
    const summonerGenerics = generics();
    const summonerSession = {};
    BotAI.executeCombat(summonerSession, summoner, npc(11040), summonerGenerics);
    assert.deepStrictEqual(summonerGenerics.skills[0], { id: 11040, selfId: 1276, ctrl: true },
        'a hot summoner must cast its learned servitor before falling back to mage damage');
    assert.strictEqual(summonerSession.lastCombatDecision.action, 'summon_servitor',
        'the hot summon action must be visible in combat telemetry');

    const necroCorpseSummon = skill(1154, {
        name: 'Summon Corrupted Man',
        mp: 70,
        type: C4SkillRules.SUMMON,
        target: 'corpse_mob',
        spell: true
    });
    necroCorpseSummon.fetchSummonNpcId = () => 12472;
    necroCorpseSummon.fetchSummonIsCubic = () => false;
    necroCorpseSummon.fetchLevel = () => 6;
    const necromancer = bot(13, [
        necroCorpseSummon,
        skill(1234, { name: 'Vampiric Claw', mp: 8, power: 40, spell: true })
    ], 100);
    necromancer.fetchId = () => 11045;
    const corpse = {
        ...npc(11046),
        fetchAttackable: () => true,
        isDead: () => true
    };
    const necroGenerics = generics();
    const necroSession = {};
    BotAI.executeCombat(necroSession, necromancer, corpse, necroGenerics);
    assert.deepStrictEqual(necroGenerics.skills[0], { id: 11046, selfId: 1154, ctrl: true },
        'a hot necromancer must cast its corpse summon on the freshly killed mob');
    assert.strictEqual(necroSession.lastCombatDecision.action, 'summon_corpse',
        'the hot necromancer corpse cast must be visible in combat telemetry');

    const necroLivingTargetGenerics = generics();
    BotAI.executeCombat({}, necromancer, npc(11047), necroLivingTargetGenerics);
    assert.strictEqual(necroLivingTargetGenerics.skills[0].selfId, 1234,
        'a necromancer must keep using its own offensive spell while the target is alive');

    assert.doesNotThrow(
        () => SummonerTactics.combatAction({}, necromancer, null, generics()),
        'a summon-aware combat tick with no selected target must not dereference a corpse target'
    );

    const controlledNecromancer = bot(13, [
        skill(1234, { name: 'Vampiric Claw', mp: 8, power: 40, spell: true })
    ], 100);
    controlledNecromancer.fetchId = () => 11048;
    EffectStore.apply(controlledNecromancer, {
        key: 'silence',
        id: 1064,
        type: 'debuff',
        category: 'silence',
        durationMs: 60000
    });
    const controlledNecromancerGenerics = generics();
    BotAI.executeCombat({}, controlledNecromancer, npc(11049), controlledNecromancerGenerics);
    assert.strictEqual(controlledNecromancerGenerics.skills.length, 0,
        'a party Necromancer under silence must not cast through the internal combat executor');
    assert.strictEqual(controlledNecromancerGenerics.attacks.length, 1,
        'a silenced party Necromancer may fall back to a basic attack');
    EffectStore.remove(controlledNecromancer, 'silence');

    const activeSummon = {
        controlMode: 'attack',
        fetchHp: () => 100,
        fetchMaxHp: () => 100
    };
    const activeSummoner = bot(14, [
        skill(1177, { name: 'Wind Strike', mp: 8, power: 40, spell: true })
    ], 100);
    activeSummoner.fetchId = () => 11041;
    activeSummoner.fetchDestId = () => 11043;
    activeSummoner.summon = activeSummon;
    const activeSummonerGenerics = generics();
    BotAI.executeCombat({}, activeSummoner, npc(11043), activeSummonerGenerics);
    assert.strictEqual(activeSummonerGenerics.skills[0].selfId, 1177,
        'a summoner with an attacking servitor must still cast its own offensive spell');
    assert.strictEqual(activeSummonerGenerics.attacks.length, 0,
        'an available summoner spell must win over the owner basic attack');

    const servitorPhysicalShield = skill(1140, {
        name: 'Servitor Physical Shield',
        mp: 44,
        target: 'pet',
        type: C4SkillRules.EFFECT,
        spell: true,
        semantic: {
            skillType: C4SkillRules.EFFECT,
            trait: 'buff',
            effect: 'servitor_physical_shield',
            effectType: 'buff',
            target: 'pet',
            stackFamily: 'pDef',
            stackOrder: 1.12,
            stats: { pDefMul: 1.12 }
        }
    });
    const strongerPartyShieldSummon = {
        effects: {},
        controlMode: 'follow',
        fetchId: () => 11060,
        fetchHp: () => 100,
        fetchMaxHp: () => 100,
        state: { fetchDead: () => false },
        isDead: () => false
    };
    EffectStore.apply(strongerPartyShieldSummon, {
        key: 'chant_of_shielding',
        id: 1009,
        level: 3,
        type: 'buff',
        stackFamily: 'pDef',
        stackOrder: 1.15,
        stats: { pDefMul: 1.15 },
        durationMs: 60000
    });
    const idleStackAwareSummoner = bot(14, [servitorPhysicalShield], 100);
    idleStackAwareSummoner.fetchId = () => 11061;
    idleStackAwareSummoner.summon = strongerPartyShieldSummon;
    const idleStackAwareGenerics = generics();
    const idleStackAwareAction = SummonerTactics.combatAction(
        {},
        idleStackAwareSummoner,
        null,
        idleStackAwareGenerics
    );
    assert.strictEqual(idleStackAwareGenerics.skills.length, 0,
        'a stronger same-family party buff must suppress a weaker servitor buff recast');
    assert.strictEqual(idleStackAwareAction.reason, 'summon_follow',
        'a fully covered servitor should return to follow state while idle');

    const combatFirstSummon = {
        effects: {},
        controlMode: 'attack',
        fetchId: () => 11062,
        fetchHp: () => 100,
        fetchMaxHp: () => 100,
        state: { fetchDead: () => false },
        isDead: () => false
    };
    const combatFirstSummoner = bot(14, [servitorPhysicalShield, skill(1177, {
        name: 'Wind Strike',
        mp: 8,
        power: 40,
        spell: true
    })], 100);
    combatFirstSummoner.fetchId = () => 11063;
    combatFirstSummoner.fetchDestId = () => 11064;
    combatFirstSummoner.summon = combatFirstSummon;
    const combatFirstGenerics = generics();
    BotAI.executeCombat({}, combatFirstSummoner, npc(11064), combatFirstGenerics);
    assert.strictEqual(combatFirstGenerics.skills[0].selfId, 1177,
        'a summoner must use its offensive skill before idle servitor maintenance');
    assert.strictEqual(combatFirstGenerics.skills.some((entry) => entry.selfId === 1140), false,
        'a summoner must not cast a servitor buff while its target is active');

    const lowMpSummon = skill(1277, {
        name: 'Summon Mew the Cat',
        mp: 70,
        type: C4SkillRules.SUMMON,
        target: 'self',
        spell: true
    });
    lowMpSummon.fetchSummonNpcId = () => 12478;
    lowMpSummon.fetchSummonIsCubic = () => false;
    const lowMpSummonerGenerics = generics();
    BotAI.executeCombat({}, bot(14, [lowMpSummon], 50), npc(11042), lowMpSummonerGenerics);
    assert.strictEqual(lowMpSummonerGenerics.skills.length, 0,
        'a hot summoner without enough MP must not attempt to cast a servitor');
    assert.strictEqual(lowMpSummonerGenerics.attacks.length, 1,
        'a hot summoner without enough MP must fall back to a normal attack');

    const raidSafeMage = bot(10, [
        skill(1235, { name: 'Area Nuke', mp: 5, power: 200, spell: true, semantic: { sourceTarget: 'area', radius: 200 } }),
        skill(1236, { name: 'Single Nuke', mp: 5, power: 20, spell: true })
    ], 100);
    const raidSafeDecision = invoke('GameServer/Bot/AI/BotCombatUtility').select(
        raidSafeMage,
        npc(11041),
        'mage',
        { avoidAreaDamage: true }
    );
    assert.strictEqual(raidSafeDecision.skill.fetchSelfId(), 1236,
        'raid combat must prefer single-target damage so controlled minions are not woken by AoE');

    const lowManaMage = bot(10, [
        skill(1177, { name: 'Wind Strike', mp: 8, power: 12, spell: true })
    ], 10);
    const lowManaMageGenerics = generics();
    BotAI.executeCombat({}, lowManaMage, npc(1109), lowManaMageGenerics);
    assert.strictEqual(lowManaMageGenerics.skills[0].selfId, 1177, 'a mage should cast whenever it can pay the spell cost, even below the old MP reserve');
    assert.strictEqual(lowManaMageGenerics.attacks.length, 0, 'a mage with mana for a nuke should not switch to melee');

    const emptyManaMage = bot(10, [
        skill(1177, { name: 'Wind Strike', mp: 8, power: 12, spell: true })
    ], 7);
    const emptyManaMageGenerics = generics();
    BotAI.executeCombat({}, emptyManaMage, npc(1110), emptyManaMageGenerics);
    assert.strictEqual(emptyManaMageGenerics.skills.length, 0, 'a mage without enough MP should not attempt an unaffordable spell');
    assert.strictEqual(emptyManaMageGenerics.attacks.length, 1, 'melee is the mage fallback only after it cannot pay for its spell');

    const sleep = skill(1097, {
        name: 'Dreaming Spirit',
        mp: 10,
        power: 20,
        spell: true,
        type: C4SkillRules.EFFECT,
        semantic: { effect: 'sleep', trait: 'sleep', effectType: 'debuff' }
    });
    const orcMage = bot(49, [
        sleep,
        skill(1177, { name: 'Wind Strike', mp: 8, power: 12, spell: true })
    ], 100);
    const orcMageGenerics = generics();
    BotAI.executeCombat({}, orcMage, npc(1107), orcMageGenerics);
    assert.strictEqual(orcMageGenerics.skills[0].selfId, 1177, 'mage damage rotation should not prefer pure Sleep over a learned nuke');

    const controlOnlyMage = bot(49, [sleep], 100);
    const controlOnlyGenerics = generics();
    BotAI.executeCombat({}, controlOnlyMage, npc(1108), controlOnlyGenerics);
    assert.strictEqual(controlOnlyGenerics.skills.length, 0, 'pure control should wait for a tactical control policy');
    assert.strictEqual(controlOnlyGenerics.attacks.length, 1, 'mage with only control skills should use the basic attack fallback');

    const reserveHealer = bot(15, [skill(1300, { mp: 20, power: 100, spell: true })], 50);
    const reserveGenerics = generics();
    BotAI.executeCombat({}, reserveHealer, npc(1105), reserveGenerics);
    assert.strictEqual(reserveGenerics.skills.length, 0, 'healer should preserve support MP instead of casting an expensive nuke');
    assert.strictEqual(reserveGenerics.attacks.length, 1, 'healer with no affordable utility should use a basic attack');

    const supportingHealer = bot(15, [skill(1301, { mp: 5, power: 20, spell: true })], 100);
    const supportingGenerics = generics();
    BotAI.executeCombat({}, supportingHealer, npc(1112), supportingGenerics, { basicAttackOnly: true });
    assert.strictEqual(supportingGenerics.skills.length, 0, 'a hot-party healer ordered to conserve MP must not use an offensive spell');
    assert.strictEqual(supportingGenerics.attacks.length, 1, 'a hot-party healer may still contribute a normal weapon attack');

    const dagger = bot(7, [
        skill(1400, { mp: 5, power: 30, range: 40 }),
        skill(1401, { mp: 5, power: 25, range: 40, type: C4SkillRules.BLOW })
    ], 100);
    const daggerGenerics = generics();
    BotAI.executeCombat({}, dagger, npc(1106), daggerGenerics);
    assert.strictEqual(daggerGenerics.skills[0].selfId, 1401, 'dagger should prefer a learned blow over generic damage');

    const protectedBoss = { ...npc(1199), fetchIsRaidBoss: () => true };
    const protectedSession = { currentTargetId: protectedBoss.fetchId() };
    const protectedGenerics = generics();
    const protectedResult = BotAI.executeCombat(protectedSession, dagger, protectedBoss, protectedGenerics);
    assert.strictEqual(protectedResult, false, 'the final combat boundary must reject a raid boss');
    assert.strictEqual(protectedSession.currentTargetId, undefined, 'rejecting a raid boss must clear a stale bot target');
    assert.strictEqual(protectedGenerics.skills.length, 0, 'a bot must not cast an offensive skill on a raid boss');
    assert.strictEqual(protectedGenerics.attacks.length, 0, 'a bot must not basic-attack a raid boss');

    const protectedMinion = { ...npc(1200), selfId: 10002 };
    const protectedMinionGenerics = generics();
    assert.strictEqual(BotAI.executeCombat({}, dagger, protectedMinion, protectedMinionGenerics), false,
        'the final combat boundary must reject raid minion templates even without a live boss link');
    assert.strictEqual(protectedMinionGenerics.attacks.length, 0, 'a bot must not basic-attack a raid minion');

    console.log('Bot combat skill selection checks passed');
} finally {
    Math.random = originalRandom;
}
