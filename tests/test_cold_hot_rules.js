// T124: the hot combat rules the cold fight lacked, each with one owner the
// hot and the cold side read. Each check gives the hot entry (Attack,
// C4SkillEffects) and the cold one (BackgroundResolver's fights,
// ColdMobAction) the same numbers and rolls and compares their outcomes; the
// solo gate (BotTargetMatchup) reads the fight's modifier.
const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();

const Attack = invoke('GameServer/Actor/Attack');
const SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const SkillModel = invoke('GameServer/Model/Skill');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Formulas = invoke('GameServer/Formulas');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const ColdMobAction = invoke('GameServer/Bot/Population/ColdMobAction');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const DataCache = invoke('GameServer/DataCache');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const HitRules = invoke('GameServer/Combat/HitRules');
const ItemTemplateIndex = invoke('GameServer/Item/ItemTemplateIndex');

const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const PveEncounter = invoke('GameServer/Bot/Population/ColdPveEncounter');
const TS = 1_791_060_000_000;

const constant = value => () => value;
const passive = stats => ({ fetchPassive: () => true, fetchSemantic: () => ({ skillType: 'passive', stats }) });
function skill(selfId, { power = 100, level = 1, spell = false, name = '' } = {}) {
    return new SkillModel({ selfId, name, passive: false, spell, distance: 600, hitTime: 1000, reuse: 1000, buff: 0, level,
        power, mp: 0, hp: 0, itemId: 0, itemCount: 0 });
}
// A hot actor and target from plain numbers; their stat bonuses and weaknesses as passives (EffectStats reads them).
function hotActor({ pAtk = 1000, mAtk = 1000, hp = 1000, maxHp = 1000, level = 40, kind = '', stats = {} } = {}) {
    return { hp, maxHp, level, effects: {}, fetchLevel() { return this.level; }, fetchHp() { return this.hp; }, fetchMaxHp() { return this.maxHp; },
        setHp(value) { this.hp = value; }, statusUpdateVitals() {}, fetchCollectivePAtk: () => pAtk, fetchCollectiveMAtk: () => mAtk,
        fetchCollectiveWit: () => 0, state: { fetchDead: () => false },
        backpack: { fetchTotalWeaponKind: () => kind, fetchTotalWeaponPAtkRnd: () => 0, fetchEquippedWeapon: () => null },
        skillset: { fetchSkills: () => [passive(stats)] } };
}
function hotTarget({ pDef = 500, mDef = 300, hp = 5000, maxHp = 5000, level = 40, race = '', undead = false, stats = {} } = {}) {
    return { hp, maxHp, level, effects: {}, fetchId: () => 7, fetchLevel() { return this.level; }, fetchHp() { return this.hp; },
        fetchMaxHp() { return this.maxHp; }, setHp(value) { this.hp = value; }, fetchCollectivePDef: () => pDef, fetchCollectiveMDef: () => mDef,
        fetchRace: () => race, fetchUndead: () => undead, fetchDex: () => 0, fetchPassiveSkills: () => [passive(stats)],
        fetchAttackable: () => true, state: { fetchDead: () => false } };
}
// The same numbers as a cold fighter (bonuses as an effect on its profile) and a cold monster view.
function coldFighter({ pAtk = 1000, mAtk = 1000, hp = 1000, maxHp = 1000, level = 40, kind = '', stats = {} } = {}) {
    return { profile: { level, pAtk, mAtk, maxHp, maxMp: 1000, accur: 1e6, critical: 0, dex: 20, str: 1,
        mCritRate: Formulas.magicCriticalRate({ wit: 0, weapon: false }),
        equipment: { weaponKind: kind, pAtkRnd: 0 }, effects: [{ key: 'test', stats }], skills: [] },
    vitals: { hp, maxHp, mp: 1000, maxMp: 1000 }, charges: 0, cooldowns: {} };
}
function coldMob({ pDef = 500, mDef = 300, maxHp = 5000, level = 40, race = '', undead = false, vulnerabilities = {}, ...rest } = {}) {
    return { selfId: 0, level, maxHp, pDef, mDef, evasion: 0, race, undead, vulnerabilities, resists: {},
        pAtk: 1, mAtk: 1, accur: 1, critical: 0, atkSpd: 253, castSpd: 333, ...rest };
}
// A solo fight (BackgroundResolver.resolveFight) of a class's reference bot
// that has learned only `skills` (their tree levels at its level), against a
// mob already engaged (its encounter: the mob, mobHp, timers; the mob acts
// only at mobReadyAt). maxActions 1: the bot's one action. Returns the result
// and the bot's state and starting vitals.
function soloFight({ classId, level, skills = [], effects = [], hp = null, mp = null, mob, mobHp = mob.maxHp, timers = {},
    rng = constant(0.5), maxActions = 1 }) {
    const state = HuntCycle.referenceState(classId, level);
    state.stats.coldCombat.skills = ColdCombatProfile.skillSnapshotsFromRecords(ColdCombatProfile.skillRecordsFromTree(classId, level)
        .filter(record => skills.includes(record.selfId)));
    assert.strictEqual(state.stats.coldCombat.skills.length, skills.length, `class ${classId} at ${level} knows ${skills}`);
    state.stats.coldCombat.effects = effects;
    const profile = ColdCombatProfile.fightProfile(state, TS);
    state.vitals = { hp: hp ?? profile.maxHp, mp: mp ?? profile.maxMp };
    const spot = { id: 'rules', avgLevel: level, npcEntries: [], rewards: { adenaMin: 0, adenaMax: 0 } };
    state.stats.pveEncounter = PveEncounter.save(null, PveEncounter.key([state], spot), mob, mobHp, TS,
        { botReadyAt: 0, mobReadyAt: 1e9, ...timers });
    const result = Resolver.resolveFight({ state, spot, pressure: {}, rng, timestamp: TS, maxActions });
    return { result, state, profile, hp: state.vitals.hp, mobHp: result.won ? 0 : result.encounter.hp };
}

// 1. One modifier (HitRules.targetModifier): a weapon's weakness, the
// attacker's race and undead bonuses; a knife's normal hit reads no dagger
// weakness, a skill does. Hot, cold and the gate's channels agree.
{
    const terms = { kind: 'Weapon.Knife', stats: { 'pAtk-monsters': 1.25, pAtkUndeadMul: 1.5 } };
    const weak = { race: 'beast', undead: true, stats: { daggerWpnVuln: 1.4 } };
    const mob = coldMob({ race: 'beast', undead: true, vulnerabilities: { daggerWpnVuln: 1.4 } });
    const fighter = coldFighter(terms);
    // A middle roll: the hit lands, no critical (critical rate 0).
    const ratio = (selected) => Resolver.combat.attackDamage(fighter, selected, mob, constant(0.5), { vsMob: true })
        / Resolver.combat.attackDamage(fighter, selected, mob, constant(0.5), { vsMob: false });
    const hotNormal = Attack.hitModifier(hotActor(terms), hotTarget(weak));
    const hotSkill = Attack.hitModifier(hotActor(terms), hotTarget(weak), { skill: true, trait: 'dagger' });
    assert.ok(Math.abs(hotNormal - 1.25 * 1.5) < 1e-9, 'a knife hit meets the race and undead bonuses, not the dagger weakness');
    assert.ok(Math.abs(hotSkill - 1.4 * 1.25 * 1.5) < 1e-9, 'a dagger skill also meets the dagger weakness');
    assert.ok(Math.abs(ratio(null) - hotNormal) < 0.01, `cold normal hit modifier ${ratio(null)} = hot ${hotNormal}`);
    // Power Strike (3): a physical skill with the knife reads the dagger weakness (hot prepareSkillDamage).
    assert.ok(Math.abs(ratio({ skill: { selfId: 3, level: 1 }, magic: false, power: 500 }) - hotSkill) < 0.01, 'cold skill modifier = hot');
    const profile = { ...fighter.profile, role: 'dps', skills: [] };
    const normal = Matchup.channels(profile, { ...mob, basePDef: mob.pDef, baseMDef: mob.mDef }).find(attack => attack.normal);
    assert.ok(Math.abs(normal.modifier - hotNormal) < 1e-9, `the gate's normal hit reads the fight's modifier (${normal.modifier})`);
}

// 2. Death Link by the caster's HP (HitRules.skillPower): hot and cold deal the same.
{
    const deathLink = skill(1159, { power: 100, level: 1, spell: true, name: 'Death Link' });
    assert.strictEqual(deathLink.fetchSemantic().skillType, Rules.DEATH_LINK);
    const hp = 250, maxHp = 1000;
    const hot = Attack.prototype.prepareSkillDamage.call(Attack.prototype, hotActor({ hp, maxHp }), hotTarget(), deathLink, true, constant(0.99));
    const fighter = coldFighter({ hp, maxHp });
    const record = { selfId: 1159, level: 1, power: 100, spell: true };
    const cold = Resolver.combat.attackDamage(fighter, { skill: record, magic: true,
        power: Resolver.effectiveSkillPower(fighter.profile, record, hp) }, coldMob(), constant(0.99));
    assert.strictEqual(cold, hot, `Death Link at a quarter HP: cold ${cold} = hot ${hot}`);
    const full = Resolver.combat.attackDamage(fighter, { skill: record, magic: true,
        power: Resolver.effectiveSkillPower(fighter.profile, record, maxHp) }, coldMob(), constant(0.99));
    assert.ok(full < cold / 2, 'at full HP Death Link is weak');
}

// 3. The magic level-fail roll: a nuke on a target far above its magic level fails whole, hot and cold.
{
    const nuke = skill(1177, { power: 30, level: 1, spell: true, name: 'Wind Strike' });
    const caster = hotActor({ level: 10 }), high = hotTarget({ level: 40 });
    const roll = 0.9;
    const hot = SkillEffects.execute({ dataSendToMe() {}, dataSendToMeAndOthers() {} }, caster, high, nuke,
        { magicSkill: true, rng: constant(roll), attack: { clearLoadedShot() {}, prepareSkillDamage: () => 100 } });
    assert.strictEqual(hot.resisted, true, 'hot: the high target resists the low nuke');
    const cold = Resolver.combat.attackDamage(coldFighter({ level: 10 }), { skill: { selfId: 1177, level: 1, spell: true }, magic: true, power: 30 },
        coldMob({ level: 40 }), constant(roll));
    assert.strictEqual(cold, 0, 'cold: the same roll fails the same nuke');
    assert.ok(Resolver.combat.attackDamage(coldFighter({ level: 40 }), { skill: { selfId: 1177, level: 1, spell: true }, magic: true, power: 30 },
        coldMob({ level: 40 }), constant(roll)) > 0, 'cold: at its level the nuke lands');
}

// 4. Lethal strike (Lethal Blow 344): hot leaves the target at 1 HP after the hit; cold the same.
{
    const lethal = skill(344, { power: 5773, name: 'Lethal Blow' });
    const target = hotTarget({ hp: 5000, maxHp: 5000, level: 40 });
    const hot = SkillEffects.execute({ dataSendToMe() {} }, hotActor({ level: 40 }), target, lethal,
        { rng: constant(0), attack: { clearLoadedShot() {}, prepareSkillDamage: () => 200 } });
    assert.strictEqual(hot.forceLethalVitals, true, 'hot: the lethal strike lands');
    // An Adventurer (93) with Lethal Blow only, the same roll.
    const cold = soloFight({ classId: 93, level: 76, skills: [344], mob: coldMob({ maxHp: 5000, level: 76 }), rng: constant(0) });
    assert.strictEqual(cold.result.debug.skillUses, 1, 'the bot strikes with Lethal Blow');
    assert.strictEqual(cold.mobHp, 1, 'cold: the mob is left at 1 HP');
    const boss = soloFight({ classId: 93, level: 76, skills: [344], mob: coldMob({ maxHp: 5000, level: 76, boss: true }), rng: constant(0) });
    assert.ok(boss.mobHp > 1 && boss.mobHp < 5000, 'a raid boss takes no lethal strike, only the hit');
}

// 5. Drain (Vampiric Claw 1234): the caster heals absorbPart of the damage, hot and cold alike.
{
    const claw = skill(1234, { power: 108, level: 28, spell: true, name: 'Vampiric Claw' });
    const caster = hotActor({ hp: 100, maxHp: 1000 });
    const hot = SkillEffects.execute({ dataSendToMe() {}, dataSendToMeAndOthers() {} }, caster, hotTarget({ hp: 5000 }), claw,
        { magicSkill: true, rng: constant(0.5), attack: { clearLoadedShot() {}, prepareSkillDamage: () => 300 } });
    const semantic = Rules.resolve({ selfId: 1234, level: 28 });
    assert.strictEqual(hot.heal, Formulas.calcDrainHeal({ damage: 300, targetHp: 5000, absorbPart: semantic.absorbPart,
        absorbAbs: semantic.absorbAbs }), 'hot: Vampiric Claw heals its share of the damage');
    // A Necromancer (13) with Vampiric Claw only: the fight heals the same share of its damage.
    const cold = soloFight({ classId: 13, level: 40, skills: [1234], hp: 100, mob: coldMob(), rng: constant(0.99) });
    const damage = 5000 - cold.mobHp, level = cold.state.stats.coldCombat.skills[0].level;
    const own = Rules.resolve({ selfId: 1234, level });
    assert.ok(damage > 0, 'the claw hits');
    // The fight's result rounds the bot's HP.
    assert.strictEqual(cold.result.hp, Math.round(100 + Formulas.calcDrainHeal({ damage, targetHp: 5000, absorbPart: own.absorbPart,
        absorbAbs: own.absorbAbs })), 'cold heals the same share');
}

// 6. Life steal (absorbDam: a weapon SA, Vampiric Rage) on a normal hit, not on a bow's; hot and cold alike.
{
    const hotGain = Attack.prototype.applyDamageAbsorb.call(Attack.prototype, null, hotActor({ hp: 500, maxHp: 1000, stats: { absorbDam: 9 } }), 400);
    assert.strictEqual(hotGain, HitRules.absorbedHp(9, 400, 500, 1000));
    const rage = [{ key: 'test_rage', stats: { absorbDam: 9 } }];
    // A Human Fighter (0) swings its sword once.
    const cold = soloFight({ classId: 0, level: 20, effects: rage, hp: 100, mob: coldMob({ level: 20 }) });
    const damage = 5000 - cold.mobHp;
    assert.ok(damage > 0, 'the swing lands');
    assert.strictEqual(cold.result.hp - 100, HitRules.absorbedHp(9, damage, 100, cold.profile.maxHp), 'cold steals the same life');
    const archer = soloFight({ classId: 9, level: 40, effects: rage, hp: 100, mob: coldMob() });
    assert.ok(archer.mobHp < 5000, 'the arrow lands');
    assert.strictEqual(archer.result.hp, 100, 'a bow steals none');
}

// 7. A monster's reflect (reflectDam: its damage shield) sends a share of each hit back, while it lives.
{
    const cold = soloFight({ classId: 0, level: 20, hp: 500, mob: coldMob({ level: 20, reflectDam: 20 }) });
    const damage = 5000 - cold.mobHp;
    assert.strictEqual(cold.hp - cold.result.hp, HitRules.reflectedDamage(20, damage), 'the bot takes 20% of its hit back');
    const killer = soloFight({ classId: 0, level: 20, hp: 500, mob: coldMob({ level: 20, reflectDam: 20 }), mobHp: 1 });
    assert.strictEqual(killer.result.won, true);
    assert.strictEqual(killer.result.hp, killer.hp, 'a killed monster sends nothing back');
}

// 8. The effect part of a damage+effect skill lands on the cold monster: Stun Shot (101) holds it,
// a bleed (223) ticks; a raid boss's passive 4045 cuts the land chance to a tenth.
{
    const mob = coldMob({ level: 40 });
    const fight = ColdMobAction.coldMobFight(mob);
    const caster = { level: 40, mAtk: 1000 };
    assert.ok(ColdMobAction.landOnMob(mob, fight, { selfId: 101, level: 15, power: 100 }, caster, 1000, constant(0)), 'a stun lands');
    assert.strictEqual(fight.heldUntil, 1000 + Rules.resolve({ selfId: 101, level: 15 }).durationMs, 'the monster is held until the stun ends');
    assert.ok(ColdMobAction.landOnMob(mob, fight, { selfId: 223, level: 1, power: 100 }, caster, 0, constant(0)), 'a bleed lands');
    const bleed = Rules.resolve({ selfId: 223, level: 1 }).dot;
    assert.strictEqual(ColdMobAction.dotDamage(fight, bleed.intervalMs * bleed.count, mob.maxHp), bleed.count * bleed.damageByLevel[0],
        'the bleed deals its ticks over its time');
    const stun = Rules.resolve({ selfId: 101, level: 15 });
    const boss = coldMob({ level: 40, vulnerabilities: { stunVuln: 0.1 } });
    const plain = ColdMobAction.controlLandChance(mob, stun, false, caster);
    assert.ok(Math.abs(ColdMobAction.controlLandChance(boss, stun, false, caster) - plain * 0.1) < 1e-9, 'passive 4045 cuts a stun to a tenth');
    // A raid boss's own passives carry 4045 (ColdCombatProfile.npcCombatStats).
    const raid = DataCache.npcs.find(npc => npc.template?.kind === 'Boss'
        && NpcSkills.passiveSkillsFor({ fetchSelfId: () => npc.selfId }).some(passiveSkill => passiveSkill.fetchSelfId?.() === 4045));
    assert.ok(raid, 'the datapack has a raid boss with passive 4045');
    assert.strictEqual(ColdCombatProfile.npcCombatStats(raid).vulnerabilities.stunVuln, 0.1);
    // The raid's minion control counts that chance, not a whole minion per controller.
    const controller = { profile: { level: 40, mAtk: 1000, skills: [{ selfId: 1069, level: 1, mp: 10, spell: true }] }, vitals: { mp: 100 } };
    const minions = { raidMinionCount: 4, level: 40, mDef: 300 };
    const free = Resolver.combat.coldRaidControlCapacity([controller], minions);
    const held = Resolver.combat.coldRaidControlCapacity([controller], { ...minions, vulnerabilities: { sleepVuln: 0.1 } });
    assert.ok(free > 0 && free < 1, `a controller holds its land chance of a minion (${free})`);
    assert.ok(Math.abs(held - free * 0.1) < 1e-9, 'the boss passive cuts it');
}

// 9. A monster's poison on a bot ticks (hot EffectTicker.applyDot): the cold fighter takes its damage over time.
{
    const poisoner = (() => {
        for (const npc of DataCache.npcs) {
            const skills = NpcSkills.combatSkillsFor({ fetchSelfId: () => npc.selfId });
            if (skills.length === 1 && skills[0].fetchSemantic?.()?.dot && skills[0].fetchConsumedMp() <= 100
                && invoke('GameServer/Npc/NpcCombatChoice').category(skills[0]) === 'debuff') {
                return { npc, skill: skills[0] };
            }
        }
        return null;
    })();
    assert.ok(poisoner, 'the datapack has a monster whose only skill is a poison or a bleed');
    const mob = ColdCombatProfile.npcForSpot({ id: 'dot_test', avgLevel: poisoner.npc.template?.level || 1,
        npcEntries: [{ selfId: poisoner.npc.selfId, count: 1 }] }, constant(0));
    const bot = invoke('GameServer/Bot/AI/HuntCycle').referenceState(1, Math.max(1, mob.level));
    const fighter = { state: bot, profile: ColdCombatProfile.profileFor(bot, 0, { store: false }), readyAt: 0,
        vitals: { hp: 1000, maxHp: 1000, mp: 100, maxMp: 100 } };
    const fight = ColdMobAction.coldMobFight(mob);
    ColdMobAction.coldMobAction(mob, fight, fighter, { time: 0, at: 0, rng: constant(0) });
    assert.ok(fighter.dots?.length === 1, 'the poison landed on the bot');
    const dot = invoke('GameServer/Combat/HitRules').dotOf(poisoner.skill.fetchSemantic(), poisoner.skill.fetchLevel(), poisoner.skill.fetchPower());
    assert.strictEqual(ColdMobAction.dotDamage(fighter, 1e9, fighter.vitals.hp), dot.count * dot.damage, 'every tick of it lands');
}

// 10. T126: a bow shot below its MP does not leave (hot BowResources.consume); the cold archer stands
// until its regeneration pays the shot, then shoots.
{
    const state = HuntCycle.referenceState(9, 40);
    const profile = ColdCombatProfile.fightProfile(state, 0);
    const bowMp = Number(profile.equipment?.bowMp) || 0;
    assert.ok(profile.equipment?.weaponKind === 'Weapon.Bow' && bowMp > 0, 'a Hawkeye shoots a bow that costs MP');
    const hot = invoke('GameServer/Actor/BowResources').consume({ botSession: {}, dataSendToMe() {} }, {
        backpack: { fetchEquippedWeapon: () => ({ fetchConsumedMp: () => bowMp, fetchSelfId: () => 0 }) },
        fetchMp: () => 0, state: { setHits() {} } }, constant(0.99));
    assert.strictEqual(hot, false, 'hot: no shot at 0 MP');
    // The first action waits for the shot's MP and shoots nothing; the second shoots and pays it.
    const waits = soloFight({ classId: 9, level: 40, mp: 0, mob: coldMob({ maxHp: 1e6 }) });
    assert.strictEqual(waits.mobHp, 1e6, 'cold: no shot at 0 MP');
    assert.ok(waits.result.encounter.botReadyAt > 0 && waits.result.mp === bowMp, 'it waits until it has the shot\'s MP');
    const shoots = soloFight({ classId: 9, level: 40, mp: 0, mob: coldMob({ maxHp: 1e6 }), maxActions: 2 });
    assert.ok(shoots.mobHp < 1e6 && shoots.result.mp === 0, 'then it shoots and pays the MP');
}

// 12. A single-target stun holds a lone mob, not a pull: the pull's other mobs
// strike on (BotPullEstimate.pullView), as hot.
{
    const stun = (mob) => soloFight({ classId: 9, level: 40, skills: [101], mob, rng: constant(0) }).result.encounter.mobFight;
    assert.ok(stun(coldMob({ maxHp: 1e6 }))?.heldFor > 0, 'Stun Shot holds one mob');
    assert.ok(!stun(coldMob({ maxHp: 1e6, pull: 3 }))?.heldFor, 'Stun Shot on one mob of a pull of three holds none');
}

// 13. A damage-over-time tick never takes the last HP point, on either side
// (HitRules.dotTickDamage, as hot EffectTicker; Lisvus EffectDamOverTime). A
// monster's poison outlives the kill and ticks the winner down to 1 HP; in
// the fight it leaves the bot at 1 HP, and the bot's bleed leaves the
// monster at 1 HP: no tick wins or loses a fight.
{
    const poison = (damage, next = 1000) => ({ botDots: [{ key: 'poison', next, left: 3, damage, intervalMs: 3000 }] });
    const won = soloFight({ classId: 0, level: 20, hp: 500, mob: coldMob({ level: 20 }), mobHp: 1, timers: poison(50) });
    assert.strictEqual(won.result.won, true);
    assert.strictEqual(won.result.hp, 500 - 150, 'the poison ticks out after the kill');
    const floored = soloFight({ classId: 0, level: 20, hp: 500, mob: coldMob({ level: 20 }), mobHp: 1, timers: poison(200) });
    assert.ok(floored.result.won && !floored.result.died && floored.result.hp === 1, 'the poison leaves the winner at 1 HP');
    const poisoned = soloFight({ classId: 0, level: 20, hp: 50, mob: coldMob({ level: 20, maxHp: 1e6 }),
        timers: { botReadyAt: 5000, ...poison(100) } });
    assert.ok(!poisoned.result.died && poisoned.result.hp >= 1, 'a monster\'s poison in the fight leaves the bot alive');
    const bled = soloFight({ classId: 0, level: 20, mob: coldMob({ level: 20 }), mobHp: 10,
        timers: { botReadyAt: 20000, mobReadyAt: 5000, mobFight: { dots: [{ key: 'bleed', next: 3000, left: 1, damage: 100, intervalMs: 3000 }] } } });
    assert.ok(!bled.result.won && bled.mobHp === 1, 'the bot\'s bleed leaves the monster at 1 HP');
}

// 14. A party member's bleed leaves the party's monster at 1 HP: the tick wins
// no fight (the member never acts in the slice; the monster acts at 5 s).
{
    const npcId = Number(Object.keys(invoke('GameServer/Items/SoulCrystalProgression').catalog.npcs)
        .find(id => ItemTemplateIndex.find(DataCache.npcs, Number(id))));
    const mob = ColdCombatProfile.npcCombatStats(ItemTemplateIndex.find(DataCache.npcs, npcId));
    const member = HuntCycle.referenceState(0, 20);
    const spot = { id: 'rules_party', avgLevel: mob.level, npcEntries: [{ selfId: npcId, count: 1 }] };
    const encounter = PveEncounter.save(null, PveEncounter.key([member], spot), mob, 10, TS, {
        mobReadyAt: 5000, readyAt: { [member.characterId]: 1e9 },
        mobFight: { dots: [{ key: 'bleed', next: 3000, left: 1, damage: 100, intervalMs: 3000, by: member.characterId }] } });
    const fight = Resolver.resolvePartyFight({ members: [member], spot, targetNpcId: npcId, rng: constant(0.5), timestamp: TS, encounter });
    assert.ok(!fight.won && fight.debug.remainingHp === 1, 'the bleed leaves the monster at 1 HP');
}

// 11. The hunt tables' formula meets a real mob's terms (T124): an undead mob by the
// rotation measured on an undead dummy (undeadMul), a weapon weakness by the gate's modifier.
{
    const M = require('../scripts/hunt-tables/HuntModel');
    // A Dwarven Fighter (53) swings a blunt.
    const state = invoke('GameServer/Bot/AI/HuntCycle').referenceState(53, 30);
    const profile = M.profileOf(state);
    const rot = { A: 0.05, B: 10, M: 0, dryUnit: 0.05, mpPhaseSec: 180, mpPerSec: 0, areaShare: 0, shotMul: 1,
        openDamage: [], openMp: [], openingSeconds: [], magicShare: 0 };
    const bot = { classId: 53, level: 30, profile, rot, potions: false };
    const base = { level: 28, maxHp: 2000, pAtk: 80, pAtkRnd: 0, pDef: 150, mDef: 120, mAtk: 50, atkSpd: 253, accur: 30, evasion: 30,
        critical: 4, atkRadius: 40, race: '', undead: false, vulnerabilities: {} };
    const fight = (combat, rotation = rot) => M.mobHour({ ...bot, rot: rotation }, { combat, exp: 100, sp: 10, pull: 1 }).fight;
    const living = fight(base);
    assert.ok(fight({ ...base, undead: true }, { ...rot, undeadMul: 2 }) < living * 0.6, 'the undead gain shortens the fight');
    assert.ok(Math.abs(fight({ ...base, undead: true }, { ...rot, undeadMul: 1 }) - living) < 1e-9, 'no undead gain, the same fight');
    assert.strictEqual(profile.equipment?.weaponKind, 'Weapon.Blunt');
    assert.ok(fight({ ...base, vulnerabilities: { bluntWpnVuln: 2 } }) < living * 0.6, 'a blunt weakness shortens the fight');
    assert.ok(Math.abs(fight({ ...base, vulnerabilities: { daggerWpnVuln: 2 } }) - living) < 1e-9, 'a dagger weakness does not meet a blunt');
    console.log('PASS hunt model reads a real target');
}

// 15. A skill rank's numbers have one owner, the hot Skill model (C4SkillRules over the
// data row); a cold record of the rank (learned rows, a class tree) carries the same.
// Summons reuse 6 h at levels 1-4 and 20 s from level 5 (Lisvus #reuseDelay); Return and
// Party Recall level 2 cast in 1.5 s and 3.5 s; Wind Shackle casts in 1.5 s and reuses in 8 s.
{
    const hotRank = (selfId, level) => {
        const data = DataCache.skills.find(entry => entry.selfId === selfId);
        const { levels, ...rest } = data;
        return new SkillModel({ ...utils.crushOb(JSON.parse(JSON.stringify(rest))), ...levels.find(entry => entry.level === level) });
    };
    const coldRank = (selfId, level) => ColdCombatProfile.skillSnapshotsFromRecords([{ selfId, level }])[0];
    const cases = [];
    for (const id of [1111, 1128, 1225, 1226, 1227, 1228]) cases.push([id, 4, { reuse: 21600000 }], [id, 5, { reuse: 20000 }]);
    cases.push([1050, 1, { hitTime: 20000 }], [1050, 2, { hitTime: 1500 }], [1255, 1, { hitTime: 20000 }], [1255, 2, { hitTime: 3500 }]);
    cases.push([1206, 1, { hitTime: 1500, reuse: 8000 }], [1206, 19, { hitTime: 1500, reuse: 8000 }]);
    for (const [id, level, expected] of cases) {
        const hot = hotRank(id, level), cold = coldRank(id, level);
        for (const [field, value] of Object.entries(expected)) {
            const hotValue = field === 'reuse' ? hot.fetchReuseTime() : hot.fetchHitTime();
            assert.strictEqual(hotValue, value, `hot ${id} level ${level} ${field} ${value}`);
            assert.strictEqual(cold[field], value, `cold ${id} level ${level} ${field} ${value}`);
        }
        assert.strictEqual(cold.spell, hot.fetchSpell(), `${id} level ${level}: one cast type hot and cold`);
        assert.strictEqual(cold.mp, hot.fetchConsumedMp(), `${id} level ${level}: one MP cost hot and cold`);
    }
    // One cast type (Lisvus isMagic): songs, dances, stances, the 3rd-class physical skills and
    // the servitor buffs are not spells; Magic Haste Potion is.
    const physical = [304, 305, 306, 307, 308, 309, 310, 311, 349, 363, 364, 365, 366, 367, 339, 340, 341, 342, 343, 344, 345,
        346, 347, 348, 350, 351, 352, 353, 354, 355, 356, 357, 358, 359, 360, 361, 362, 369, 1346, 1347, 1349];
    for (const [id, magic] of [...physical.map(id => [id, false]), [2169, true]]) {
        assert.strictEqual(hotRank(id, 1).fetchSpell(), magic, `hot ${id} magic ${magic}`);
        assert.strictEqual(coldRank(id, 1).spell, magic, `cold ${id} magic ${magic}`);
    }
    // The servitor's lifetime and crystal upkeep come with the record, as hot.
    const kat = coldRank(1111, 5);
    assert.deepStrictEqual([kat.totalLifeTime, kat.itemIdOT, kat.itemConsumeSteps], [1200000, 1458, 1], 'Kat the Cat\'s summon terms');
    // A class tree's record (class-only estimates) reads the same owner.
    const tree = ColdCombatProfile.skillsFor({ level: 40 }, 14, 40).find(record => record.selfId === 1111);
    assert.strictEqual(tree?.reuse, 20000, 'a level 40 Warlock\'s tree Kat the Cat reuses in 20 s');
    console.log('PASS skill rank numbers: cold records read the hot Skill model');
}

console.log('Cold fight hot rules checks passed');
