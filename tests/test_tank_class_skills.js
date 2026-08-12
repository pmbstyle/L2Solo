const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const DataCache = invoke('GameServer/DataCache');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');
const SkillModel = invoke('GameServer/Model/Skill');
const ToggleSkills = invoke('GameServer/Skills/ToggleSkills');
const skillRequest = invoke('GameServer/Actor/Generics/SkillRequest');
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
        shield: overrides.shield !== false,
        skillset: { fetchSkills: () => overrides.skills || [] },
        fetchPassiveSkills: () => [],
        fetchId: () => overrides.id ?? 2000001,
        fetchLevel: () => overrides.level ?? 78,
        fetchLocX: () => 100,
        fetchLocY: () => 200,
        fetchLocZ: () => 300,
        fetchHead: () => 0,
        fetchCollectiveMAtk: () => 100,
        fetchCollectiveMDef: () => 100,
        fetchMp() { return this.mp; },
        setMp(next) { this.mp = next; },
        fetchHp() { return this.hp; },
        setHp(next) { this.hp = next; },
        fetchMaxHp() { return this.maxHp; },
        fetchDestId() { return this.destId; },
        clearDestId() { this.destId = undefined; },
        statusUpdateVitals() {},
        automation: { aborted: false, abortAll() { this.aborted = true; } },
        attack: { cleared: false, clearTimers() { this.cleared = true; }, resetQueuedEvent() {} },
        state: {
            hits: true,
            casts: true,
            combats: true,
            inMotion: () => false,
            fetchTowards: () => false,
            fetchWalkin: () => false,
            fetchSeated: () => false,
            fetchDead: () => false,
            setTowards() {},
            setHits(next) { this.hits = next; },
            setCasts(next) { this.casts = next; },
            setCombats(next) { this.combats = next; }
        },
        backpack: {
            fetchTotalWeaponKind: () => overrides.weaponKind || 'Weapon.Sword',
            fetchEquippedArmors: () => (overrides.armorKinds || ['Armor.Chain', ...(value.shield ? ['Armor.Shield'] : [])])
                .map((kind) => ({ fetchKind: () => kind })),
            fetchTotalShieldPDef: () => value.shield ? 100 : 0
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

const tankClassIds = [4, 5, 6, 19, 20, 32, 33, 90, 91, 99, 106];
const tankTrees = skillTree.filter((tree) => tankClassIds.includes(tree.classId));
assert.strictEqual(tankTrees.length, tankClassIds.length, 'every C4 knight and tank profession must have a skill tree');
const tankSkillIds = new Set(tankTrees.flatMap((tree) => tree.skills.map((entry) => entry.selfId)));
for (const id of [110, 127, 143, 153, 196, 197, 232, 288, 291, 316, 318, 322, 335, 341, 342, 350, 351, 352, 353, 368]) {
    assert(tankSkillIds.has(id), `tank class trees should expose skill ${id}`);
}

DataCache.init();
const cached = (id) => DataCache.skills.find((entry) => entry.selfId === id);
assert.strictEqual(cached(127).levels.length, 14, 'Hamstring should materialize all 14 C4 levels');
assert.deepStrictEqual(cached(127).levels.at(-1), { level: 14, power: 80, mp: 35, hp: 0, itemId: 0, itemCount: 0 }, 'Hamstring level 14 should preserve sourced power and total MP cost');
assert.strictEqual(cached(232).levels.length, 52, 'Heavy Armor Mastery should materialize all 52 C4 levels');
assert.strictEqual(cached(196).template.passive, false, 'Holy Blade should be an activatable toggle');
assert.strictEqual(cached(197).template.passive, false, 'Holy Armor should be an activatable toggle');

const hamstring = C4SkillRules.resolve({ selfId: 127, name: 'Hamstring', level: 14 });
assert.strictEqual(hamstring.power, 80, 'Hamstring should use sourced effect power');
assert.strictEqual(hamstring.mpConsume, 35, 'Hamstring level 14 should use the sourced total MP cost');
assert.strictEqual(hamstring.mpInitialConsume, 7, 'Hamstring level 14 should use sourced initial MP consumption');
assert.strictEqual(hamstring.stats.runSpdMul, 0.5, 'Hamstring should halve run speed');

const tankPassives = actor({
    skills: [
        skill(143, 'Cubic Mastery', 2, { passive: true }),
        skill(153, 'Shield Mastery', 4, { passive: true }),
        skill(232, 'Heavy Armor Mastery', 52, { passive: true }),
        skill(291, 'Final Fortress', 11, { passive: true }),
        skill(316, 'Aegis', 1, { passive: true })
    ],
    hp: 300
});
assert.strictEqual(C4SkillRules.resolve({ selfId: 143, level: 2 }).skillType, C4SkillRules.PASSIVE, 'Cubic Mastery must remain passive');
assert.strictEqual(EffectStats.multiplier(tankPassives, 'rShldMul'), 2, 'Shield Mastery level 4 should double shield rate');
assert(Math.abs(EffectStats.add(tankPassives, 'pDefAdd') - (172.6 + 215.8)) < 0.001, 'heavy armor and low-HP fortress defense should stack');
assert.strictEqual(EffectStats.add(tankPassives, 'shieldDefAngle'), 360, 'Aegis should enable shield defense from every direction');
tankPassives.hp = 301;
assert(Math.abs(EffectStats.add(tankPassives, 'pDefAdd') - 172.6) < 0.001, 'Final Fortress should stop above 30 percent HP');
tankPassives.shield = false;
assert.strictEqual(EffectStats.multiplier(tankPassives, 'rShldMul'), 1, 'Shield Mastery should require an equipped shield');
assert.strictEqual(EffectStats.add(tankPassives, 'shieldDefAngle'), 0, 'Aegis should require an equipped shield');

const wrongArmor = actor({ skills: [skill(232, 'Heavy Armor Mastery', 52, { passive: true })], armorKinds: ['Armor.Leather'] });
assert.strictEqual(EffectStats.add(wrongArmor, 'pDefAdd'), 0, 'Heavy Armor Mastery should require chain/heavy armor');

for (const [id, name, level, initialMp, drain, interval] of [
    [196, 'Holy Blade', 1, 8, 0, 0],
    [197, 'Holy Armor', 2, 9, 0, 0],
    [288, 'Guard Stance', 4, 13, 1, 3000],
    [318, 'Aegis Stance', 1, 9, 9, 2000],
    [322, 'Shield Fortress', 6, 14, 0.4, 3000],
    [335, 'Fortitude', 1, 35, 0.5, 3000]
]) {
    const semantic = C4SkillRules.resolve({ selfId: id, name, level });
    assert.strictEqual(semantic.operateType, 'toggle', `${name} should use toggle lifecycle`);
    assert.strictEqual(semantic.mpInitialConsume ?? 0, initialMp, `${name} should use sourced activation MP`);
    assert.strictEqual(semantic.toggleMpConsume ?? 0, drain, `${name} should use sourced periodic MP`);
    assert.strictEqual(semantic.toggleIntervalMs ?? 0, interval, `${name} should use sourced drain interval`);
}

const holyActor = actor();
ToggleSkills.handleRequest(session(holyActor), holyActor, skill(197, 'Holy Armor', 2));
assert.strictEqual(EffectStats.multiplier(holyActor, 'darkVuln'), 0.9, 'Holy Armor level 2 should reduce dark vulnerability');
assert.strictEqual(holyActor.mp, 991, 'Holy Armor level 2 should consume 9 MP on activation');
assert.strictEqual(EffectStore.list(holyActor)[0].manaDot, null, 'Holy Armor should not periodically drain MP when the source effect value is zero');

const holyBladeActor = actor();
ToggleSkills.handleRequest(session(holyBladeActor), holyBladeActor, skill(196, 'Holy Blade', 1));
assert.strictEqual(holyBladeActor.mp, 992, 'Holy Blade should consume 8 MP on activation');
assert.strictEqual(EffectStats.multiplier(holyBladeActor, 'pAtkUndeadMul'), 1.3, 'Holy Blade should increase damage against undead');

const guarding = actor();
ToggleSkills.handleRequest(session(guarding), guarding, skill(288, 'Guard Stance', 4));
assert.strictEqual(guarding.mp, 987, 'Guard Stance level 4 should consume 13 MP on activation');
assert.strictEqual(EffectStats.add(guarding, 'pDefAdd'), 256.5, 'Guard Stance level 4 should add sourced P.Def');

const aegisActor = actor();
ToggleSkills.handleRequest(session(aegisActor), aegisActor, skill(318, 'Aegis Stance', 1));
assert.strictEqual(aegisActor.mp, 991, 'Aegis Stance should consume 9 MP on activation');
assert.strictEqual(EffectStats.add(aegisActor, 'shieldDefAngle'), 360, 'Aegis Stance should enable shield defense from every direction');
assert.strictEqual(EffectStats.multiplier(aegisActor, 'sDefMul'), 0.6, 'Aegis Stance should apply its shield-defense penalty');

const fortitudeActor = actor();
ToggleSkills.handleRequest(session(fortitudeActor), fortitudeActor, skill(335, 'Fortitude', 1));
assert.strictEqual(fortitudeActor.mp, 965, 'Fortitude should consume 35 MP on activation');
assert.strictEqual(EffectStats.multiplier(fortitudeActor, 'paralyzeVuln'), 0.7, 'Fortitude should reduce paralysis vulnerability');
assert.strictEqual(EffectStats.multiplier(fortitudeActor, 'stunVuln'), 0.7, 'Fortitude should reduce stun vulnerability');

const shieldless = actor({ shield: false });
const shieldlessSession = session(shieldless);
ToggleSkills.handleRequest(shieldlessSession, shieldless, skill(322, 'Shield Fortress', 6));
assert.strictEqual(EffectStore.list(shieldless).length, 0, 'Shield Fortress must not activate without a shield');
assert.strictEqual(shieldless.mp, 1000, 'rejected Shield Fortress must not consume MP');
assert(shieldlessSession.packets.some((packet) => packet[0] === 0x25), 'rejected Shield Fortress should send ActionFailed');

const fortified = actor();
ToggleSkills.handleRequest(session(fortified), fortified, skill(322, 'Shield Fortress', 6));
assert.strictEqual(fortified.mp, 986, 'Shield Fortress level 6 should consume 14 MP on activation');
assert.strictEqual(EffectStats.add(fortified, 'sDefAdd'), 560, 'Shield Fortress level 6 should add sourced shield defense');

const defender = actor();
const ultimateDefense = skill(110, 'Ultimate Defense', 2, { buff: 30000 });
C4SkillEffects.execute(session(defender), defender, defender, ultimateDefense, { magicSkill: false, rng: () => 0, attack: { clearLoadedShot() {} } });
assert.strictEqual(EffectStats.add(defender, 'pDefAdd'), 3600, 'Ultimate Defense level 2 should add sourced P.Def');
assert.strictEqual(EffectStats.add(defender, 'mDefAdd'), 2700, 'Ultimate Defense level 2 should add sourced M.Def');
assert.strictEqual(EffectRestrictions.canMove(defender), false, 'Ultimate Defense should make the caster immobile');
assert.strictEqual(EffectRestrictions.canAttack(defender), true, 'Ultimate Defense should still allow attacks');

const taunter = actor();
const taunted = actor({ id: 1000001 });
taunted.enterCombatState = function enterCombatState(_session, enemy) { this.aggroTarget = enemy; };
const vengeance = skill(368, 'Vengeance', 1, { power: 3994, buff: 30000 });
const vengeanceOutcome = C4SkillEffects.execute(session(taunter), taunter, taunted, vengeance, { magicSkill: false, rng: () => 0, attack: { clearLoadedShot() {} } });
assert(vengeanceOutcome.aggroDamage > 0, 'Vengeance should generate aggro damage rather than HP damage');
assert.strictEqual(taunted.aggroTarget, taunter, 'Vengeance should engage affected enemies on the caster');
assert.strictEqual(EffectStats.add(taunter, 'pDefAdd'), 5400, 'Vengeance should apply its self P.Def bonus');
assert.strictEqual(EffectStats.add(taunter, 'mDefAdd'), 4050, 'Vengeance should apply its self M.Def bonus');
assert.strictEqual(EffectRestrictions.canMove(taunter), false, 'Vengeance should make the caster immobile');
assert.strictEqual(C4SkillRules.resolve({ selfId: 368, level: 1 }).radius, 80, 'Vengeance should use the C4 default aura radius');

const auraRequester = actor();
auraRequester.skillset.fetchSkill = () => vengeance;
auraRequester.isDead = () => false;
auraRequester.isBlocked = () => false;
auraRequester.canUseSkill = () => true;
auraRequester.fetchDestId = () => undefined;
auraRequester.automation.fetchDestId = () => undefined;
const vengeanceRequest = { selfId: 368 };
skillRequest(session(auraRequester), auraRequester, vengeanceRequest);
assert.strictEqual(vengeanceRequest.id, auraRequester.fetchId(), 'Vengeance should be caster-centered without a selected target');
assert.strictEqual(auraRequester.storedSpell, vengeanceRequest, 'targetless Vengeance should reach the native cast queue');

const lonelyVengeanceCaster = actor();
const lonelyOutcome = C4SkillEffects.execute(session(lonelyVengeanceCaster), lonelyVengeanceCaster, lonelyVengeanceCaster, vengeance, {
    magicSkill: false,
    selfEffectOnly: true,
    attack: { clearLoadedShot() {} }
});
assert(lonelyOutcome.selfEffect, 'Vengeance should apply its self effect even when no enemy is inside the aura');
assert.strictEqual(EffectRestrictions.canMove(lonelyVengeanceCaster), false, 'targetless Vengeance should still immobilize the caster');

const shieldTarget = actor({ id: 1000002, destId: 2000001 });
const shieldBash = skill(352, 'Shield Bash', 1, { buff: 3000 });
assert.strictEqual(new Attack().skillUseConditionFailure(taunter, shieldBash), null, 'Shield Bash should pass its shield equipment gate');
const bashOutcome = C4SkillEffects.execute(session(taunter), taunter, shieldTarget, shieldBash, { magicSkill: false, rng: () => 0, attack: { clearLoadedShot() {} } });
assert(EffectStore.hasDebuff(shieldTarget, 'stun'), 'Shield Bash should apply its sourced stun');
assert.strictEqual(shieldTarget.fetchDestId(), undefined, 'Shield Bash should remove the victim target');
assert.strictEqual(bashOutcome.effect.expiresAt - Date.now() <= 3000, true, 'Shield Bash should last no longer than 3 seconds');

const slamTarget = actor({ id: 1000003, destId: 2000001 });
const shieldSlam = skill(353, 'Shield Slam', 1, { buff: 120000 });
C4SkillEffects.execute(session(taunter), taunter, slamTarget, shieldSlam, { magicSkill: false, rng: () => 0, attack: { clearLoadedShot() {} } });
assert.strictEqual(EffectRestrictions.canAttack(slamTarget), false, 'Shield Slam should block physical attacks');
assert.strictEqual(EffectRestrictions.canCast(slamTarget), true, 'Shield Slam should not block magic casts');
assert.strictEqual(slamTarget.fetchDestId(), undefined, 'Shield Slam should remove the victim target');

const lifeCaster = actor();
const lifeTarget = actor({ id: 2000002, hp: 100, maxHp: 1000 });
const touchOfLife = skill(341, 'Touch of Life', 1, { buff: 1 });
const lifeOutcome = C4SkillEffects.execute(session(lifeCaster), lifeCaster, lifeTarget, touchOfLife, { magicSkill: false, rng: () => 0, attack: { clearLoadedShot() {} } });
assert.strictEqual(lifeOutcome.heal, 500, 'Touch of Life should immediately heal 50 percent of max HP');
assert.strictEqual(lifeTarget.hp, 600, 'Touch of Life should work on a friendly target');
assert.strictEqual(lifeOutcome.effect.expiresAt - Date.now() > 119000, true, 'Touch of Life should last 120 seconds');
assert.deepStrictEqual(lifeOutcome.effect.hot, { count: 40, intervalMs: 3000, heal: 150 }, 'Touch of Life should restore 150 HP every 3 seconds');
assert.strictEqual(EffectStats.multiplier(lifeTarget, 'gainHpMul'), 1.3, 'Touch of Life should increase received healing');

const deathTarget = actor({ id: 1000004 });
EffectStore.apply(deathTarget, { key: 'might', id: 1068, level: 3, type: 'buff', durationMs: 60000, stats: { pAtkMul: 1.12 } });
EffectStore.apply(deathTarget, { key: 'poison', id: 129, level: 3, type: 'debuff', category: 'poison', durationMs: 60000, stats: {} });
EffectStore.apply(deathTarget, { key: 'root', id: 102, level: 16, type: 'debuff', category: 'root', durationMs: 60000, stats: { runSpdMul: 0.5 } });
const touchOfDeath = skill(342, 'Touch of Death', 1, { buff: 1 });
assert.strictEqual(
    new Attack().skillUseConditionFailure(actor({ hp: 751, maxHp: 1000 }), touchOfDeath),
    "Can only be used when one's own remaining HP is 75% or less.",
    'Touch of Death should reject a caster above 75 percent HP'
);
const deathOutcome = C4SkillEffects.execute(session(taunter), taunter, deathTarget, touchOfDeath, { magicSkill: false, rng: () => 0, attack: { clearLoadedShot() {} } });
assert.strictEqual(deathOutcome.cancelled.length, 2, 'Touch of Death should negate existing dispellable buffs and debuffs');
assert.strictEqual(EffectStore.list(deathTarget).length, 2, 'Touch of Death should leave its own effect and source-excluded root in this fixture');
assert(EffectStore.hasDebuff(deathTarget, 'root'), 'Touch of Death must not remove Root when its C4 negateStats omit ROOT');
assert.strictEqual(EffectStats.multiplier(deathTarget, 'maxCpMul'), 0.1, 'Touch of Death should reduce maximum CP by 90 percent');
assert.strictEqual(EffectStats.multiplier(deathTarget, 'gainHpMul'), 0.7, 'Touch of Death should reduce received healing');

const mirrorTarget = actor({ id: 1000005, destId: 2000001 });
EffectStore.apply(mirrorTarget, { key: 'physical_mirror', id: 350, level: 1, type: 'buff', durationMs: 60000, stats: { reflectSkillPhysic: 100 } });
taunter.effects = {};
taunter.destId = mirrorTarget.fetchId();
const reflected = C4SkillEffects.execute(session(taunter), taunter, mirrorTarget, shieldBash, { magicSkill: false, rng: () => 0, attack: { clearLoadedShot() {} } });
assert.strictEqual(reflected.reflected, true, 'Physical Mirror should reflect physical skill effects');
assert(EffectStore.hasDebuff(taunter, 'stun'), 'reflected Shield Bash should stun its caster');
assert.strictEqual(EffectStore.hasDebuff(mirrorTarget, 'stun'), false, 'the mirror owner should not receive the reflected stun');

const magicalMirrorTarget = actor({ id: 1000006 });
EffectStore.apply(magicalMirrorTarget, { key: 'magical_mirror', id: 351, level: 1, type: 'buff', durationMs: 60000, stats: { reflectSkillMagic: 100 } });
const magicCaster = actor({ id: 2000006 });
const reflectedHamstring = C4SkillEffects.execute(session(magicCaster), magicCaster, magicalMirrorTarget, skill(127, 'Hamstring', 14, { spell: true, buff: 120000 }), {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(reflectedHamstring.reflected, true, 'Magical Mirror should reflect magic skill effects');
assert(EffectStore.hasDebuff(magicCaster, 'hamstring'), 'reflected Hamstring should slow its caster');
assert.strictEqual(EffectStore.hasDebuff(magicalMirrorTarget, 'hamstring'), false, 'the Magical Mirror owner should not receive the reflected slow');

const deathMirrorTarget = actor({ id: 1000007 });
EffectStore.apply(deathMirrorTarget, { key: 'physical_mirror', id: 350, level: 1, type: 'buff', durationMs: 60000, stats: { reflectSkillPhysic: 100 } });
const reflectedDeathCaster = actor({ id: 2000007 });
EffectStore.apply(reflectedDeathCaster, { key: 'might', id: 1068, level: 3, type: 'buff', durationMs: 60000, stats: { pAtkMul: 1.12 } });
const reflectedDeath = C4SkillEffects.execute(session(reflectedDeathCaster), reflectedDeathCaster, deathMirrorTarget, touchOfDeath, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(reflectedDeath.reflected, true, 'Physical Mirror should reflect Touch of Death before its negate step');
assert.strictEqual(EffectStore.list(deathMirrorTarget).some((effect) => effect.key === 'physical_mirror'), true, 'the mirror owner should retain Physical Mirror after reflection');
assert.strictEqual(EffectStore.list(reflectedDeathCaster).some((effect) => effect.key === 'might'), false, 'reflected Touch of Death should negate the caster buffs');
assert(EffectStore.hasDebuff(reflectedDeathCaster, 'touch_of_death'), 'reflected Touch of Death should debuff its caster');

[holyActor, holyBladeActor, guarding, aegisActor, fortitudeActor, fortified, defender, taunter, lonelyVengeanceCaster, shieldTarget, slamTarget, lifeTarget, deathTarget, mirrorTarget, magicalMirrorTarget, magicCaster, deathMirrorTarget, reflectedDeathCaster].forEach(EffectTicker.clearAll);

console.log('Tank class skill checks passed');
