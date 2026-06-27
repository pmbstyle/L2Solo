const assert = require('assert');

require('../src/Global');

const Actor = invoke('GameServer/Actor/Actor');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const ChangeClass = invoke('GameServer/World/Generics/NpcBypasses/ChangeClass');

DataCache.init();

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

function waitTick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

(async () => {
    const lowSession = createSession({ level: 19, classId: 0 });
    ChangeClass(lowSession, ['change-class', '4', 'Human', 'Knight']);
    assert.strictEqual(lowSession.packets.at(-1)[0], 0x0f, 'low-level class change rejection should render NPC HTML');

    const session = createSession({ level: 20, classId: 0 });
    ChangeClass(session, ['change-class', '4', 'Human', 'Knight']);
    await waitTick();

    assert.strictEqual(session.actor.fetchClassId(), 4, 'class change should update the live actor class id');
    assert.deepStrictEqual(Database.lastClassUpdate, { id: 9101, classId: 4 }, 'class change should persist the target class id');
    assert.ok(session.actor.fetchMaxHp() > 80, 'class change should recalculate vitals');
    assert.ok(session.actor.skillset.fetchSkills().length > 1, 'class change should award target-class skills');
    assert.ok(session.packets.some((packet) => packet[0] === 0x58), 'class change should send SkillsList');
    assert.ok(session.packets.some((packet) => packet[0] === 0x04), 'class change should send UserInfo');
    assert.ok(session.packets.some((packet) => packet[0] === 0x0e), 'class change should send StatusUpdate');
    assert.strictEqual(session.packets.at(-1)[0], 0x0f, 'class change success should render NPC HTML without htmlPacket');

    console.log('Class change checks passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
