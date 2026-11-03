const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Progression = invoke('GameServer/ClassProgression');
const Profiles = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Cold = invoke('GameServer/Bot/Population/ColdClassPolicy');
const Utility = invoke('GameServer/Bot/AI/BotCombatUtility');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Weapons = invoke('GameServer/Bot/AI/BotWeaponCompatibility');
const Skillset = invoke('GameServer/Actor/Skillset');
Data.init();
const templates = structuredClone(require('../data/Templates/templates.json'));
Progression.expandTemplates(templates);
const inheritedDrain = Profiles.skillSnapshotsFromRecords([{ selfId: 1147, level: 2 }])[0];
assert.strictEqual(inheritedDrain.spell, true);
assert.strictEqual(inheritedDrain.hitTime, 4000);
assert.strictEqual(inheritedDrain.reuse, 12000);
let cases = 0, gearCases = 0, summonCases = 0;
for (const { classId } of templates) {
    const level = Progression.lineage(classId).length === 1 ? 19 : Progression.lineage(classId).length === 2 ? 39 : Progression.lineage(classId).length === 3 ? 74 : 78;
    const minLevel = [1, 20, 40, 76][Progression.lineage(classId).length - 1];
    for (const gearLevel of [19, 20, 39, 40, 51, 52, 60, 61, 75, 76, 78].filter(n => n >= minLevel)) {
        const plan = Gear.planFor({ stats: { classId, level: gearLevel } });
        assert.deepStrictEqual(plan, Gear.planFor({ classId, level: gearLevel }));
        const weapon = plan.items.map(i => Data.items.find(d => d.selfId === i.selfId)).find(i => i.template.kind.startsWith('Weapon.'));
        assert(weapon, `class ${classId} level ${gearLevel} has a weapon plan`);
        assert(Weapons.isCompatibleWeapon(weapon.template.kind, plan.role, classId));
        assert.strictEqual(new Set(plan.items.map(i => i.slot)).size, plan.items.length, 'no conflicting equipment slots');
        gearCases++;
    }
    const plan = Gear.planFor({ classId, level });
    const weapon = plan.items.map(i => Data.items.find(d => d.selfId === i.selfId)).find(i => i.template.kind.startsWith('Weapon.'));
    const records = Profiles.skillSnapshotsFromRecords(Profiles.skillRecordsFromTree(classId, level));
    const profile = { classId, level, maxHp: 1000, maxMp: 1000, skills: records,
        equipment: { weaponKind: weapon.template.kind, shieldPDef: plan.items.some(i => i.slot === 8) ? 100 : 0 } };
    const skills = new Skillset().populateSnapshot(records);
    const state = {};
    const hot = { fetchClassId: () => classId, fetchLevel: () => level,
        fetchHp: () => state.hp, fetchMaxHp: () => 1000, fetchMp: () => state.mp, fetchMaxMp: () => 1000,
        fetchCharges: () => state.charges, canUseSkill: s => (state.cooldowns[s.fetchSelfId()] || 0) <= 1000,
        skillset: { skills, fetchSkills: () => skills },
        backpack: { fetchTotalWeaponKind: () => profile.equipment.weaponKind,
            fetchEquippedArmors: () => profile.equipment.shieldPDef ? [{ fetchKind: () => 'Armor.Shield' }] : [] } };
    for (const pvp of [false, true]) for (const party of [false, true]) for (const undead of [false, true]) for (const mp of [0, 100, 350, 1000]) for (const hp of [250, 1000]) for (const charges of [0, 3]) {
        Object.assign(state, { hp, mp, charges, cooldowns: {} });
        const mob = { maxHp: 1000, undead };
        const target = { fetchHp: () => 1000, fetchUndead: () => undead };
        const policy = { mode: `${party ? 'party' : 'solo'}_${pvp ? 'pvp' : 'pve'}` };
        const role = Roles.combatRoleFor(hot);
        const expected = Utility.select(hot, target, role, policy);
        const actual = Cold.select(profile, { ...state, mob, party, pvp, time: 1000 });
        assert.strictEqual(actual?.skill.selfId, expected?.skill.fetchSelfId(), `class ${classId} ${JSON.stringify(state)} mode=${policy.mode} undead=${undead}`);
        assert.deepStrictEqual(actual?.reasons, expected?.reasons, 'the selected class mode and intent must match');
        const prep = Utility.selectChargePlan(hot, role, policy, target);
        assert.strictEqual(Cold.select(profile, { ...state, mob, party, pvp, time: 1000, prepare: true })?.selfId, prep?.skill.fetchSelfId());
        if (actual) {
            state.cooldowns[actual.skill.selfId] = 2000;
            assert.notStrictEqual(Cold.select(profile, { ...state, mob, party, pvp, time: 1000 })?.skill.selfId, actual.skill.selfId, 'reuse affects cached adapter on the next decision');
        }
        cases++;
    }
    if (Roles.isSummoner(hot)) {
        Object.assign(state, { hp: 250, mp: 1000, charges: 0, cooldowns: {} });
        hot.summon = { isDead: () => false };
        const target = { fetchHp: () => 1000, fetchUndead: () => false };
        const expected = Utility.select(hot, target, Roles.combatRoleFor(hot), { mode: 'solo_pve' });
        const actual = Cold.select(profile, { ...state, time: 1000, mob: { maxHp: 1000 }, summon: { active: true } });
        assert.strictEqual(actual?.skill.selfId, expected?.skill.fetchSelfId());
        assert.strictEqual(actual?.score, expected?.score, 'active servitor preference must cross the cold adapter');
        summonCases++;
    }
}
console.log(`Class parity passed: ${cases} hot/cold decisions and charge plans; ${gearCases} gear boundary cases across 89 classes; ${summonCases} active-servitor cases`);
