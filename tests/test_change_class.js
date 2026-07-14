const assert = require('assert');

require('../src/Global');

const Actor = invoke('GameServer/Actor/Actor');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const ChangeClass = invoke('GameServer/World/Generics/NpcBypasses/ChangeClass');

DataCache.init();

const thirdClassTrees = DataCache.skillTree.filter((tree) => tree.classId >= 88 && tree.classId <= 118);
assert.strictEqual(thirdClassTrees.length, 31, 'all C4 third-class skill trees must be present');
assert.strictEqual(DataCache.classTemplates.filter((template) => template.classId >= 88 && template.classId <= 118).length, 31, 'all C4 third classes must have login templates');
assert.ok(thirdClassTrees.every((tree) => tree.skills.every((skill) => DataCache.skills.some((definition) => definition.selfId === skill.selfId))), 'every third-class tree skill must have a loaded definition');

let storedSkills = [{ selfId: 194, level: 1, passive: true }];
Database.updateCharacterClassId = (id, classId) => {
    Database.lastClassUpdate = { id, classId };
    return Promise.resolve();
};
Database.updateCharacterVitals = () => Promise.resolve();
Database.fetchSkill = (characterId, selfId) => Promise.resolve(storedSkills.filter((skill) => skill.selfId === selfId));
Database.setSkill = (skill) => {
    storedSkills.push(skill);
    return Promise.resolve();
};
Database.updateSkillLevel = (characterId, selfId, level) => {
    const stored = storedSkills.find((skill) => skill.selfId === selfId);
    if (stored) {
        stored.level = level;
    }
    return Promise.resolve();
};
Database.fetchSkills = () => Promise.resolve(storedSkills);

function createSession({ level = 20, classId = 0 } = {}) {
    const classInfo = DataCache.classTemplates.find((row) => row.classId === classId);
    const session = {
        packets: [],
        dataSendToMe(packet) { this.packets.push(packet); },
        dataSendToOthers(packet) { this.packets.push(packet); },
        dataSendToMeAndOthers(packet) { this.packets.push(packet); }
    };

    session.actor = new Actor(session, {
        id: 9101,
        name: 'ClassTester',
        username: 'tester',
        level,
        exp: DataCache.experience[level - 1] ?? 0,
        sp: 0,
        hp: 80,
        mp: 30,
        sex: 0,
        classId,
        locX: 0,
        locY: 0,
        locZ: 0,
        head: 0,
        face: 0,
        hair: 0,
        hairColor: 0,
        title: '',
        karma: 0,
        pk: 0,
        pvp: 0,
        evalScore: 0,
        recRemain: 0,
        isGM: 1,
        isActive: 1,
        ...utils.crushOb(classInfo),
        items: [],
        paperdoll: utils.tupleAlloc(16, {})
    });

    return session;
}

(async () => {
    const lowSession = createSession({ level: 19, classId: 0 });
    ChangeClass(lowSession, ['change-class', '4', 'Human', 'Knight']);
    assert.strictEqual(lowSession.packets.at(-1)[0], 0x0f, 'low-level class change rejection should render NPC HTML');

    const session = createSession({ level: 20, classId: 0 });
    await ChangeClass(session, ['change-class', '4', 'Human', 'Knight']);

    assert.strictEqual(session.actor.fetchClassId(), 4, 'class change should update the live actor class id');
    assert.deepStrictEqual(Database.lastClassUpdate, { id: 9101, classId: 4 }, 'class change should persist the target class id');
    assert.ok(session.actor.fetchMaxHp() > 80, 'class change should recalculate vitals');
    assert.ok(session.actor.skillset.fetchSkills().length > 1, 'class change should award target-class skills');
    assert.ok(session.packets.some((packet) => packet[0] === 0x58), 'class change should send SkillsList');
    assert.ok(session.packets.some((packet) => packet[0] === 0x04), 'class change should send UserInfo');
    assert.ok(session.packets.some((packet) => packet[0] === 0x0e), 'class change should send StatusUpdate');
    assert.ok(session.packets.some((packet) => packet[0] === 0x03), 'class change should refresh the character class for nearby clients');
    assert.strictEqual(session.packets.at(-1)[0], 0x0f, 'class change success should render NPC HTML without htmlPacket');

    const incompleteDataSession = createSession({ level: 20, classId: 18 });
    await ChangeClass(incompleteDataSession, ['change-class', '22', 'Elven', 'Scout']);

    assert.strictEqual(incompleteDataSession.actor.fetchClassId(), 22, 'missing skill definitions must not leave the actor on an unrefreshed transfer');
    assert.ok(incompleteDataSession.actor.skillset.fetchSkills().some((skill) => skill.fetchSelfId() === 15), 'defined target-class skills should still be awarded');
    assert.ok(incompleteDataSession.actor.skillset.fetchSkills().some((skill) => skill.fetchSelfId() === 312), 'newly defined target-class skills must be persisted and sent to the client');
    assert.ok(incompleteDataSession.packets.some((packet) => packet[0] === 0x58), 'incomplete skill data must still finish with SkillsList');
    assert.ok(incompleteDataSession.packets.some((packet) => packet[0] === 0x04), 'incomplete skill data must still finish with UserInfo');

    const thirdClassSession = createSession({ level: 76, classId: 2 });
    await ChangeClass(thirdClassSession, ['change-class', '88', 'Duelist']);

    assert.strictEqual(thirdClassSession.actor.fetchClassId(), 88, 'third class transfer should update the live actor class id');
    assert.strictEqual(DataCache.classTemplates.find((template) => template.classId === 88)?.template.class, 'Duelist', 'third class must have a template for the next login');
    assert.ok(thirdClassSession.actor.skillset.fetchSkills().some((skill) => skill.fetchSelfId() === 329), 'third class skills should be awarded at level 76');
    assert.strictEqual(createSession({ level: 76, classId: 94 }).actor.isSpellcaster(), 1, 'third-class mages must retain caster MP and armor calculations');

    console.log('Class change checks passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
