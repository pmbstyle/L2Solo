const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const DataCache = invoke('GameServer/DataCache');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const Formulas = invoke('GameServer/Formulas');
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
        cp: overrides.cp ?? 0,
        skills: overrides.skills || [],
        fetchId: () => overrides.id ?? 2000001,
        fetchLevel: () => overrides.level ?? 76,
        fetchLocX: () => overrides.x ?? 0,
        fetchLocY: () => overrides.y ?? 0,
        fetchLocZ: () => 0,
        fetchHead: () => 0,
        fetchAttackable: () => overrides.kind === 'Monster' || overrides.kind === 'Boss',
        fetchCollectivePAtk: () => overrides.pAtk ?? 100,
        fetchCollectivePDef: () => overrides.pDef ?? 100,
        fetchCollectiveMDef: () => 100,
        fetchDex: () => 30,
        fetchHp() { return this.hp; },
        setHp(next) { this.hp = next; },
        fetchMaxHp() { return this.maxHp; },
        fetchCp() { return this.cp; },
        setCp(next) { this.cp = next; },
        fetchMp() { return this.mp; },
        setMp(next) { this.mp = next; },
        fetchPassiveSkills: () => [],
        skillset: { fetchSkills: () => value.skills },
        statusUpdateVitals() {},
        automation: { abortAll() {} },
        attack: { clearTimers() {}, resetQueuedEvent() {} },
        state: {
            inMotion: () => false,
            fetchWalkin: () => false,
            fetchSeated: () => overrides.seated === true,
            fetchDead: () => false,
            setTowards() {},
            setHits() {},
            setCasts() {},
            setCombats() {}
        },
        backpack: {
            fetchTotalWeaponKind: () => overrides.weaponKind || 'Weapon.Bow',
            fetchTotalWeaponPAtkRnd: () => 0,
            fetchTotalShieldRate: () => 0,
            fetchTotalShieldPDef: () => 0,
            fetchEquippedArmors: () => (overrides.armorKinds || ['Armor.Leather']).map((kind) => ({ fetchKind: () => kind }))
        }
    };
    if (overrides.kind) value.fetchKind = () => overrides.kind;
    if (overrides.raid === true) value.fetchIsRaidBoss = () => true;
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

const archerClassIds = [7, 9, 22, 24, 35, 37, 92, 102, 109];
const archerTrees = skillTree.filter((tree) => archerClassIds.includes(tree.classId));
assert.strictEqual(archerTrees.length, archerClassIds.length, 'every C4 archer profession must have a skill tree');
const archerSkillIds = new Set(archerTrees.flatMap((tree) => tree.skills.map((entry) => entry.selfId)));
for (const id of [19, 24, 56, 99, 101, 113, 208, 233, 256, 303, 312, 313, 314, 323, 324, 330, 334, 343, 369]) {
    assert(archerSkillIds.has(id), `archer class trees should expose skill ${id}`);
}

DataCache.init();
const cachedStunShot = DataCache.skills.find((entry) => entry.selfId === 101);
assert.strictEqual(cachedStunShot.levels.length, 40, 'Stun Shot should materialize all 40 C4 levels');
assert.deepStrictEqual(
    cachedStunShot.levels.at(-1),
    { level: 40, power: 1827, mp: 166, hp: 0, itemId: 0, itemCount: 0 },
    'Stun Shot should materialize its sourced level-40 values instead of cloning the last raw datapack row'
);
assert.strictEqual(cachedStunShot.template.distance, 900, 'Stun Shot should use its sourced 900-unit cast range');

const coldArcher = ColdCombatProfile.profileFor({ level: 74, stats: { classId: 37 }, inventory: {} });
const coldStunShot = coldArcher.skills.find((entry) => entry.selfId === 101);
assert.deepStrictEqual(
    [coldStunShot.level, coldStunShot.power, coldStunShot.mp],
    [40, 1827, 166],
    'cold archer fallback should consume the sourced maximum Stun Shot level values'
);

const stunShot = skill(101, 'Stun Shot', 40, { power: 1, mp: 1, distance: 900 });
assert.strictEqual(stunShot.fetchSkillType(), C4SkillRules.DAMAGE_EFFECT, 'Stun Shot should deal physical damage and attempt a stun');
assert.strictEqual(stunShot.fetchPower(), 1827, 'Stun Shot should resolve sourced level-40 power');
assert.strictEqual(stunShot.fetchConsumedMp(), 166, 'Stun Shot should resolve sourced level-40 MP cost');
assert.strictEqual(stunShot.fetchSemantic().magicLevel, 74, 'Stun Shot should resolve sourced level-40 magic level');
assert.deepStrictEqual(stunShot.fetchSemantic().requires, { weaponsAllowed: 32 }, 'Stun Shot should require a bow');

const passives = actor({
    skills: [
        skill(113, 'Long Shot', 2, { passive: true }),
        skill(208, 'Bow Mastery', 52, { passive: true }),
        skill(233, 'Light Armor Mastery', 47, { passive: true })
    ]
});
assert.strictEqual(EffectStats.add(passives, 'pAtkRangeAdd'), 400, 'Long Shot should add 400 range while a bow is equipped');
assert.strictEqual(EffectStats.add(passives, 'pAtkAdd'), 794.6, 'Bow Mastery should apply sourced max-level P.Atk');
assert.strictEqual(EffectStats.add(passives, 'pEvasionRateAdd'), 7, 'Light Armor Mastery should apply sourced max-level evasion');

const toggleActor = actor({ mp: 200 });
const toggleSession = session(toggleActor);
for (const [id, name, initialMp, drain, stat, value] of [
    [256, 'Accuracy', 1, 0.2, 'pAccuracyCombatAdd', 3],
    [312, 'Vicious Stance', 4, 0.4, 'pCritDamageAdd', 35],
    [334, 'Focus Skill Mastery', 36, 1, 'skillMastery', 2]
]) {
    const toggle = skill(id, name);
    const beforeMp = toggleActor.fetchMp();
    assert.strictEqual(ToggleSkills.handleRequest(toggleSession, toggleActor, toggle), true, `${name} should activate through the toggle lifecycle`);
    assert.strictEqual(toggleActor.fetchMp(), beforeMp - initialMp, `${name} should consume sourced activation MP`);
    assert.strictEqual(EffectStats.add(toggleActor, stat), value, `${name} should apply its active stat`);
    assert.strictEqual(toggle.fetchSemantic().toggleMpConsume, drain, `${name} should retain sourced periodic MP drain`);
    ToggleSkills.handleRequest(toggleSession, toggleActor, toggle);
    assert.strictEqual(ToggleSkills.isActive(toggleActor, toggle), false, `${name} should turn off on a second request`);
}

const sniper = actor();
const snipe = skill(313, 'Snipe', 8);
const snipeOutcome = C4SkillEffects.execute(session(sniper), sniper, sniper, snipe, {
    magicSkill: false,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(snipeOutcome.effect?.key, 'snipe', 'Snipe should create its 120-second self effect');
assert(EffectStore.remainingMs(sniper, 'snipe') > 119000, 'Snipe should retain sourced 120-second duration');
assert.strictEqual(EffectStats.add(sniper, 'pAtkAdd'), 177, 'Snipe level 8 should add sourced P.Atk');
assert.strictEqual(EffectStats.add(sniper, 'pAccuracyCombatAdd'), 3, 'Snipe should add sourced accuracy');
assert.strictEqual(EffectStats.multiplier(sniper, 'pCritRateMul'), 1.2, 'Snipe should add 20 percent of base critical rate');
assert.strictEqual(EffectRestrictions.canMove(sniper), false, 'Snipe should immobilize its caster while active');
assert.strictEqual(new Attack().skillUseConditionFailure(actor({ seated: true }), snipe), 'Cannot use while sitting.', 'Snipe should require the sourced standing state');

assert.strictEqual(Formulas.calcFatalPower(2908, 1000, 1000), 0, 'Fatal Counter should add no skill power at full HP');
assert.strictEqual(Formulas.calcFatalPower(2908, 500, 1000), 5089, 'Fatal Counter should scale linearly to 1.75x skill power at half HP');
const fatalCounter = skill(314, 'Fatal Counter', 1, { power: 2908, distance: 900 });
assert.strictEqual(fatalCounter.fetchSkillType(), C4SkillRules.FATAL, 'Fatal Counter should use sourced FATAL damage semantics');
const attack = new Attack();
const fullHpArcher = actor({ hp: 1000, maxHp: 1000 });
const lowHpArcher = actor({ hp: 250, maxHp: 1000 });
const damageTarget = actor({ id: 1000001, kind: 'Monster', pDef: 100 });
const fullHpDamage = attack.prepareSkillDamage(fullHpArcher, damageTarget, fatalCounter, false, () => 0.99);
const lowHpDamage = attack.prepareSkillDamage(lowHpArcher, damageTarget, fatalCounter, false, () => 0.99);
assert(lowHpDamage > fullHpDamage, 'Fatal Counter damage should increase as the archer loses HP');

assert.strictEqual(Formulas.calcLethalStrikeChance(76, 76, 76), 2, 'equal-level lethal chance should match the sourced two percent');
assert.strictEqual(Formulas.calcLethalStrikeChance(70, 76, 76), 0, 'the Lisvus middle lethal level band should retain its integer-division behavior');
const lethalShot = skill(343, 'Lethal Shot', 1, { spell: true, power: 5132, distance: 900 });
const lethalTarget = actor({ id: 1000002, kind: 'Monster', hp: 1000, maxHp: 1000, level: 76 });
const lethalOutcome = C4SkillEffects.execute(session(fullHpArcher), fullHpArcher, lethalTarget, lethalShot, {
    magicSkill: lethalShot.fetchSpell(),
    rng: () => 0,
    attack: { clearLoadedShot() {}, prepareSkillDamage: () => 200 }
});
assert.strictEqual(lethalShot.fetchSpell(), false, 'Lethal Shot should execute as a physical bow skill');
assert.strictEqual(lethalOutcome.lethal, true, 'Lethal Shot should run the sourced lethal-strike formula');
assert.strictEqual(lethalOutcome.damage, 200, 'Lethal Shot should keep its ordinary hit damage for the attack pipeline');
assert.strictEqual(lethalOutcome.forceLethalVitals, true, 'a successful Lethal Shot should request the separate post-hit one-HP effect');
const raidTarget = actor({ id: 1000003, kind: 'Boss', raid: true, hp: 1000, maxHp: 1000, level: 76 });
const raidOutcome = C4SkillEffects.execute(session(fullHpArcher), fullHpArcher, raidTarget, lethalShot, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {}, prepareSkillDamage: () => 200 }
});
assert.strictEqual(raidOutcome.lethal, false, 'Lethal Shot must not lethal-strike raid bosses');
assert.strictEqual(raidOutcome.damage, 200, 'raid bosses should still receive ordinary shot damage');
assert.strictEqual(raidOutcome.forceLethalVitals, false, 'raid bosses must not receive the post-hit lethal effect');

const evadingArcher = actor();
const evadeShot = skill(369, 'Evade Shot', 1, { spell: true, power: 2020, mp: 130, distance: 900, buff: 30000 });
const evadeOutcome = C4SkillEffects.execute(session(evadingArcher), evadingArcher, damageTarget, evadeShot, {
    magicSkill: evadeShot.fetchSpell(),
    attack: { clearLoadedShot() {}, prepareSkillDamage: () => 321 }
});
assert.strictEqual(evadeShot.fetchSpell(), false, 'Evade Shot should execute as a physical bow skill');
assert.strictEqual(evadeOutcome.damage, 321, 'Evade Shot should deal its physical shot damage');
assert.strictEqual(evadeOutcome.selfEffect?.key, 'evade_shot', 'Evade Shot should apply its self effect after firing');
assert.strictEqual(EffectStats.add(evadingArcher, 'pEvasionRateAdd'), 6, 'Evade Shot should grant sourced +6 evasion for 30 seconds');

assert.deepStrictEqual(
    [C4SkillRules.resolve({ selfId: 323 }).createItemId, C4SkillRules.resolve({ selfId: 324 }).createItemId],
    [1344, 1345],
    'Sagittarius quiver skills should create the sourced A- and S-grade arrows'
);

console.log('Archer class skill checks passed');
