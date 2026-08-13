const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const SkillExec = invoke('GameServer/Actor/Generics/SkillExec');
const SkillRequest = invoke('GameServer/Actor/Generics/SkillRequest');
const SkillModel = invoke('GameServer/Model/Skill');
const World = invoke('GameServer/World/World');
const skillTree = require('../data/Skills/Tree/tree.json');

DataCache.init();

function cachedSkill(selfId, level = 1) {
    const data = DataCache.skills.find((entry) => entry.selfId === selfId);
    assert(data, `skill ${selfId} should be materialized`);
    const levelData = data.levels.find((entry) => entry.level === level);
    assert(levelData, `skill ${selfId} level ${level} should be materialized`);
    return new SkillModel({ ...utils.crushOb(data), ...levelData });
}

function passive(selfId, level = 1) {
    return new SkillModel({ selfId, name: `passive_${selfId}`, level, passive: true, spell: false, distance: -1, mp: 0, hp: 0, power: 1 });
}

function statActor(skills = [], armorKinds = []) {
    const armors = armorKinds.map((entry) => {
        const { kind, slot } = typeof entry === 'string' ? { kind: entry, slot: 15 } : entry;
        return { fetchKind: () => kind, fetchSlot: () => slot };
    });
    return {
        effects: {},
        skillset: { fetchSkills: () => skills },
        fetchPassiveSkills: () => [],
        backpack: {
            fetchEquippedArmors: () => armors,
            fetchEquippedArmor: (slot) => armors.find((item) => item.fetchSlot() === slot),
            fetchTotalWeaponKind: () => 'Weapon.Staff'
        },
        state: { inMotion: () => false, fetchWalkin: () => false, fetchSeated: () => false }
    };
}

const classSignatures = new Map([
    [15, [235, 236, 1012, 1027, 1201]],
    [16, [1018, 1020, 1219, 1254, 1271]],
    [17, [1045, 1048, 1243, 259]],
    [29, [1013, 1206, 1257]],
    [30, [1255, 1259, 1303, 1304]],
    [42, [1059, 1206, 1268]],
    [43, [1018, 1219, 1242, 1303]],
    [49, [134, 250, 251, 252, 253]],
    [50, [1002, 1003, 1006, 1229]],
    [51, [1004, 1249, 1256, 1261, 1305]],
    [52, [1251, 1252, 1253, 1284]],
    [97, [1335, 1353, 1360, 1361]],
    [98, [1352, 1356, 1358, 1359]],
    [105, [1354, 1355, 1359]],
    [112, [1354, 1357, 1358]],
    [115, [1364, 1365, 1366, 1367]],
    [116, [1362, 1363]]
]);

for (const [classId, expectedIds] of classSignatures) {
    const tree = skillTree.find((entry) => entry.classId === classId);
    assert(tree, `buffer/healer class ${classId} should have a C4 skill tree`);
    const ids = new Set(tree.skills.map((entry) => entry.selfId));
    expectedIds.forEach((id) => assert(ids.has(id), `buffer/healer class ${classId} should retain sourced skill ${id}`));
}

const sourcedLevels = new Map();
for (const tree of skillTree.filter((entry) => classSignatures.has(entry.classId))) {
    for (const skill of tree.skills) {
        const maxLevel = Math.max(...skill.levels.map((entry) => entry.level));
        sourcedLevels.set(skill.selfId, Math.max(sourcedLevels.get(skill.selfId) || 0, maxLevel));
    }
}
for (const [selfId, maxLevel] of sourcedLevels) {
    const data = DataCache.skills.find((entry) => entry.selfId === selfId);
    assert(data, `buffer/healer skill ${selfId} should have an executable definition`);
    assert(data.levels.some((entry) => entry.level === maxLevel), `buffer/healer skill ${selfId} should materialize sourced level ${maxLevel}`);
}

for (const [selfId, maxLevel] of [[134, 1], [235, 41], [236, 41], [250, 42], [251, 45], [252, 45], [253, 43], [259, 33]]) {
    const skill = cachedSkill(selfId, maxLevel);
    assert.strictEqual(skill.fetchPassive(), true, `passive ${selfId} must not appear as an active attack`);
    assert.strictEqual(skill.fetchSkillType(), C4SkillRules.PASSIVE, `passive ${selfId} must resolve as passive`);
}

const toughness = statActor([passive(134)]);
assert.strictEqual(EffectStats.multiplier(toughness, 'rootVuln'), 0.8, 'Toughness should reduce root vulnerability');
assert.strictEqual(EffectStats.multiplier(toughness, 'sleepVuln'), 0.8, 'Toughness should reduce sleep vulnerability');
assert.strictEqual(EffectStats.multiplier(toughness, 'poisonVuln'), 0.8, 'Toughness should reduce poison vulnerability');

const robeMastery = statActor([passive(251, 45)], [
    { kind: 'Armor.Fabric', slot: 10 },
    { kind: 'Armor.Fabric', slot: 11 }
]);
assert.strictEqual(EffectStats.add(robeMastery, 'pDefAdd'), 128.8, 'high-level Robe Mastery should add sourced P.Def for a complete robe set');
const incompleteRobe = statActor([passive(251, 45)], [{ kind: 'Armor.Fabric', slot: 10 }]);
assert.strictEqual(EffectStats.add(incompleteRobe, 'pDefAdd'), 0, 'Robe Mastery should not activate from only one armor piece');

const lightMastery = statActor([passive(252, 45)], ['Armor.Leather']);
assert.strictEqual(EffectStats.add(lightMastery, 'pDefAdd'), 118.2, 'Light Armor Mastery should add sourced P.Def');
assert.strictEqual(EffectStats.multiplier(lightMastery, 'castSpdMul'), 1.9, 'Light Armor Mastery should increase casting speed');
assert.strictEqual(EffectStats.multiplier(lightMastery, 'pAtkSpdMul'), 1.25, 'Light Armor Mastery should increase attack speed');
assert.strictEqual(EffectStats.multiplier(lightMastery, 'regMp'), 1.2, 'Light Armor Mastery should increase MP regeneration');

const heavyMastery = statActor([passive(253, 43)], ['Armor.Chain']);
assert.strictEqual(EffectStats.add(heavyMastery, 'pDefAdd'), 93.3, 'Heavy Armor Mastery should add sourced P.Def');
assert.strictEqual(EffectStats.multiplier(heavyMastery, 'castSpdMul'), 1.71, 'Heavy Armor Mastery should increase casting speed');
assert.strictEqual(EffectStats.multiplier(heavyMastery, 'pAtkSpdMul'), 1.25, 'Heavy Armor Mastery should increase attack speed');

const weaponMastery = statActor([passive(250, 42)]);
assert.strictEqual(EffectStats.add(weaponMastery, 'pAtkAdd'), 79.4, 'Orc Weapon Mastery should add sourced P.Atk');
assert.strictEqual(EffectStats.add(weaponMastery, 'mAtkAdd'), 99.3, 'Orc Weapon Mastery should add sourced M.Atk');
assert.strictEqual(EffectStats.multiplier(weaponMastery, 'pAtkMul'), 1.45, 'Orc Weapon Mastery should multiply P.Atk');
assert.strictEqual(EffectStats.multiplier(weaponMastery, 'mAtkMul'), 1.17, 'Orc Weapon Mastery should multiply M.Atk');

for (const id of [1003, 1004, 1005, 1008, 1249, 1250, 1256, 1260, 1261, 1282, 1305, 1364, 1365]) {
    const semantic = cachedSkill(id).fetchSemantic();
    assert.strictEqual(semantic.target, 'ally', `Paagrio skill ${id} should use sourced TARGET_ALLY`);
    assert.strictEqual(semantic.radius, 400, `Paagrio skill ${id} should use sourced 400 radius`);
}
for (const id of [1229, 1251, 1252, 1253, 1271]) {
    const semantic = cachedSkill(id).fetchSemantic();
    assert.strictEqual(semantic.target, 'party', `party support skill ${id} should use sourced TARGET_PARTY`);
    assert.strictEqual(semantic.radius, 1000, `party support skill ${id} should use sourced 1000 radius`);
}
assert.strictEqual(cachedSkill(1253, 3).fetchSemantic().stats.pCritDamageMul, 1.5, 'Chant of Rage level 3 should grant the sourced 50% critical-damage bonus');
assert.strictEqual(cachedSkill(1256, 13).fetchSkillType(), C4SkillRules.HOT, 'Heart of Paagrio should be a pure HoT without an invented initial heal');
const heartOfPaagrioHot = cachedSkill(1256, 13).fetchSemantic().hot;
assert.strictEqual(heartOfPaagrioHot.count, 15, 'Heart of Paagrio should tick 15 times');
assert.strictEqual(heartOfPaagrioHot.intervalMs, 1000, 'Heart of Paagrio should tick once per second');
assert.strictEqual(heartOfPaagrioHot.heal, 58, 'Heart of Paagrio level 13 should use the sourced per-tick heal');

function targetActor(id, x, clanId, dead = false) {
    return {
        fetchId: () => id,
        fetchClanId: () => clanId,
        fetchIsOnline: () => true,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchHead: () => 0,
        isDead: () => dead,
        state: { fetchDead: () => dead }
    };
}

const originalUsers = World.user;
const ClanService = invoke('GameServer/Clan/ClanService');
const originalFindClan = ClanService.findById;
try {
    const caster = targetActor(2001001, 0, 10);
    const ownSummon = targetActor(1001001, 20, 0);
    caster.summon = ownSummon;
    const clanMember = targetActor(2001002, 300, 10);
    const memberSummon = targetActor(1001002, 350, 0);
    clanMember.summon = memberSummon;
    const otherClan = targetActor(2001003, 100, 11);
    const distantClanMember = targetActor(2001004, 401, 10);
    const allianceMember = targetActor(2001005, 200, 12);
    ClanService.findById = (id) => ({ id, allyId: [10, 12].includes(Number(id)) ? 77 : 0 });
    const casterSession = { actor: caster };
    World.user = { sessions: [casterSession, { actor: clanMember }, { actor: otherClan }, { actor: distantClanMember }, { actor: allianceMember }] };

    const attack = new Attack();
    const allyTargets = attack.resolveSkillTargets(casterSession, caster, caster, cachedSkill(1003));
    assert.deepStrictEqual(
        allyTargets.map((target) => target.fetchId()),
        [caster.fetchId(), ownSummon.fetchId(), clanMember.fetchId(), memberSummon.fetchId(), allianceMember.fetchId()],
        'TARGET_ALLY should affect the caster, living clan/alliance members and their living summons inside 400 range'
    );

    const deadClanMember = targetActor(2001010, 250, 10, true);
    const aliveClanMember = targetActor(2001011, 200, 10);
    const deadOtherClan = targetActor(2001012, 150, 11, true);
    const distantDeadClanMember = targetActor(2001013, 901, 10, true);
    World.user = { sessions: [casterSession, { actor: deadClanMember }, { actor: aliveClanMember }, { actor: deadOtherClan }, { actor: distantDeadClanMember }] };
    const corpseTargets = attack.resolveSkillTargets(casterSession, caster, caster, cachedSkill(1254, 6));
    assert.deepStrictEqual(corpseTargets.map((target) => target.fetchId()), [deadClanMember.fetchId()], 'Mass Resurrection should select only dead clan members inside its 900 radius');

    const partyMember = targetActor(2001020, 500, 0);
    const partySummon = targetActor(1001020, 550, 0);
    partyMember.summon = partySummon;
    const partyMemberSession = { actor: partyMember, partyCompanion: true, followPlayerSession: casterSession };
    World.user = { sessions: [casterSession, partyMemberSession] };
    const partyTargets = attack.resolveSkillTargets(casterSession, caster, caster, cachedSkill(1251));
    assert.deepStrictEqual(
        partyTargets.map((target) => target.fetchId()),
        [caster.fetchId(), ownSummon.fetchId(), partyMember.fetchId(), partySummon.fetchId()],
        'TARGET_PARTY chants should include living party summons inside the sourced radius'
    );
} finally {
    World.user = originalUsers;
    ClanService.findById = originalFindClan;
}

function casterCenteredSkillCheck(skill) {
    let executedTarget = null;
    const actor = targetActor(2002001, 0, 10);
    actor.skillset = { fetchSkill: () => skill };
    actor.fetchDestId = () => undefined;
    actor.canUseSkill = () => true;
    actor.isBlocked = () => false;
    actor.state.inMotion = () => false;
    actor.state.fetchTowards = () => 'none';
    actor.automation = {
        fetchDestId: () => undefined,
        abortAll() {},
        scheduleAction() { throw new Error('caster-centred support skills must not schedule movement to a selected target'); }
    };
    actor.attack = { remoteHit(_session, target) { executedTarget = target; } };
    const session = { actor, dataSendToMe() {}, dataSendToMeAndOthers() {} };
    const request = { selfId: skill.fetchSelfId() };
    SkillRequest(session, actor, request);
    assert.strictEqual(request.id, actor.fetchId(), `skill ${skill.fetchSelfId()} request should be centered on its caster`);
    SkillExec(session, actor, request);
    assert.strictEqual(executedTarget, actor, `skill ${skill.fetchSelfId()} execution should start from its caster`);
}

casterCenteredSkillCheck(cachedSkill(1003));
casterCenteredSkillCheck(cachedSkill(1254, 6));
casterCenteredSkillCheck(cachedSkill(1251));

const originalInvoke = global.invoke;
let recalledTarget = null;
try {
    global.invoke = (module) => {
        if (module === 'GameServer/World/TownRespawn') {
            return {
                getRespawnCoords: () => ({ locX: 10, locY: 20, locZ: 30 }),
                getChaoticRespawnCoords: () => ({ locX: -10, locY: -20, locZ: -30 })
            };
        }
        if (module === 'GameServer/Actor/Generics/TeleportTo') {
            return (_session, target, coords) => { recalledTarget = { target, coords }; };
        }
        return originalInvoke(module);
    };
    const recallTarget = targetActor(2003001, 0, 0);
    const recallSession = { actor: recallTarget };
    recallTarget.session = recallSession;
    recallTarget.fetchKarma = () => 0;
    const outcome = C4SkillEffects.execute(recallSession, recallTarget, recallTarget, cachedSkill(1050), {
        magicSkill: true,
        attack: { clearLoadedShot() {} }
    });
    assert.strictEqual(outcome.recalled, true, 'Recall should execute as a native town teleport instead of a no-op');
    assert.strictEqual(recalledTarget.target, recallTarget, 'Recall should teleport its resolved target');
    assert.deepStrictEqual(recalledTarget.coords, { locX: 10, locY: 20, locZ: 30 }, 'Recall should use the target location to resolve its town destination');

    recalledTarget = null;
    recallTarget.fetchPrivateStoreType = () => 1;
    const storeOutcome = C4SkillEffects.execute(recallSession, recallTarget, recallTarget, cachedSkill(1050), {
        magicSkill: true,
        attack: { clearLoadedShot() {} }
    });
    assert.strictEqual(storeOutcome.recalled, false, 'Recall should reject a target operating a private store');
    assert.strictEqual(recalledTarget, null, 'a rejected Recall must not emit a teleport');

    recallTarget.fetchPrivateStoreType = () => 0;
    const clanHallOutcome = C4SkillEffects.execute(recallSession, recallTarget, recallTarget, cachedSkill(2040), {
        magicSkill: true,
        attack: { clearLoadedShot() {} }
    });
    assert.strictEqual(clanHallOutcome.recalled, false, 'Clan Hall escape must not silently fall back to a town destination');
    assert.strictEqual(recalledTarget, null, 'an unsupported destination-specific escape must not emit the wrong teleport');
} finally {
    global.invoke = originalInvoke;
}

console.log('Buffer and healer skill checks passed');
