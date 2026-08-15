const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const ClassProgression = invoke('GameServer/ClassProgression');
const BotClassProgression = invoke('GameServer/Bot/BotClassProgression');
const GeneratedColdSeeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');

DataCache.init();

const firstProfessionChoices = new Set(Array.from({ length: 30 }, (_, index) => (
    BotClassProgression.nextClass(0, 20, `starter_${index}`)
)));
assert(firstProfessionChoices.size > 1, 'first-profession choices must vary across a generated fighter cohort');

// Exercise the same racial starter slots as generated population, but use the
// durable character id for profession choice. This must cover every branch,
// including the previously starved Swordsinger and Bladedancer paths.
const secondProfessionChoices = new Map();
const starterRegions = ['human', 'elf', 'dark_elf', 'orc', 'dwarf'];
for (let index = 2000000; index < 2005000; index++) {
    const characterId = index;
    starterRegions.forEach((starterRegion) => {
        const base = GeneratedColdSeeder.baseForIndex(index, starterRegion);
        const firstClass = BotClassProgression.nextClass(base.classId, 20, characterId);
        const secondOptions = ClassProgression.secondProfMap[firstClass] || [];
        if (!secondOptions.length) return;
        if (!secondProfessionChoices.has(firstClass)) secondProfessionChoices.set(firstClass, new Set());
        secondProfessionChoices.get(firstClass).add(
            BotClassProgression.nextClass(firstClass, 40, characterId)
        );
    });
}
Object.entries(ClassProgression.secondProfMap).forEach(([classId, options]) => {
    const observed = [...(secondProfessionChoices.get(Number(classId)) || [])].sort((a, b) => a - b);
    assert.deepStrictEqual(observed, [...options].sort((a, b) => a - b),
        `generated population IDs must reach every second-profession branch from ${classId}`);
});

const original = {
    fetchSkill: Database.fetchSkill,
    fetchSkills: Database.fetchSkills,
    setSkill: Database.setSkill,
    updateSkillLevel: Database.updateSkillLevel,
    updateCharacterClassId: Database.updateCharacterClassId
};
const stored = new Map();
const classes = new Map();

function skillsFor(characterId) {
    if (!stored.has(characterId)) stored.set(characterId, []);
    return stored.get(characterId);
}

try {
    Database.fetchSkill = (characterId, selfId) => Promise.resolve(skillsFor(characterId).filter((skill) => skill.selfId === selfId));
    Database.fetchSkills = (characterId) => Promise.resolve(skillsFor(characterId));
    Database.setSkill = (skill, characterId) => {
        skillsFor(characterId).push({ selfId: skill.selfId, name: skill.name, level: skill.level, passive: skill.passive });
        return Promise.resolve();
    };
    Database.updateSkillLevel = (characterId, selfId, level) => {
        const skill = skillsFor(characterId).find((entry) => entry.selfId === selfId);
        if (skill) skill.level = level;
        return Promise.resolve();
    };
    Database.updateCharacterClassId = (characterId, classId) => {
        classes.set(characterId, classId);
        return Promise.resolve();
    };

    Promise.all([
        BotClassProgression.reconcile({ characterId: 1, classId: 31, level: 42, seed: 'Halen1183' }),
        BotClassProgression.reconcile({ characterId: 2, classId: 49, level: 42, seed: 'Bren1465' }),
        BotClassProgression.reconcile({ characterId: 3, classId: 2, level: 76, seed: 'Veteran' })
    ]).then(([darkFighter, orcMystic, veteran]) => {
        assert.ok([33, 34, 36, 37].includes(darkFighter.classId),
            'a level 42 Dark Fighter must pass both profession transfers through a valid branch');
        assert.ok([51, 52].includes(orcMystic.classId), 'a level 42 Orc Mystic must pass both profession transfers');
        assert.strictEqual(veteran.classId, 88, 'a level 76 second-class bot must take its third profession');
        assert.strictEqual(skillsFor(1).find((skill) => skill.selfId === 239)?.level, 2, 'a C-grade bot must receive Expertise C through its real profession tree');
        assert.strictEqual(skillsFor(2).find((skill) => skill.selfId === 239)?.level, 2, 'all promoted C-grade paths must receive Expertise C');
        skillsFor(1).forEach((skill) => {
            const defined = DataCache.skills.find((entry) => entry.selfId === skill.selfId)?.levels || [];
            assert.ok(defined.some((entry) => entry.level === skill.level), `bot skills must use a defined datapack level (${skill.selfId}:${skill.level})`);
        });
        assert.strictEqual(classes.get(3), 88, 'the third profession must be persisted');
        assert.strictEqual(BotRoles.inferRole(97), 'healer', 'Cardinal must retain its healer role');
        assert.strictEqual(BotRoles.inferRole(98), 'buffer', 'Hierophant must retain its buffer role');
        assert.strictEqual(BotRoles.inferRole(21), 'buffer', 'Swordsinger must be treated as party support');
        assert.strictEqual(BotRoles.inferRole(34), 'buffer', 'Bladedancer must be treated as party support');
        assert.strictEqual(BotRoles.inferRole(52), 'buffer', 'Warcryer must not be treated as a damage mage');
        assert.strictEqual(BotRoles.inferRole(100), 'buffer', 'Sword Muse must retain its buffer role');
        assert.strictEqual(BotRoles.inferRole(107), 'buffer', 'Spectral Dancer must retain its buffer role');
        assert.strictEqual(BotRoles.inferRole(116), 'buffer', 'Doomcryer must retain its buffer role');
        assert.strictEqual(BotRoles.className(100), 'Sword Muse', 'list presentation must use a human-readable profession');
        assert.strictEqual(BotRoles.inferRole({ classId: 30 }), 'healer', 'persisted character rows must resolve roles from classId');
        assert.strictEqual(BotRoles.presentation(null).classId, null, 'a missing profession must not be mistaken for Human Fighter');
        assert.strictEqual(BotRoles.inferRole(118), 'crafter', 'Maestro must retain its crafter role');
        console.log('Bot class progression checks passed');
    }).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    }).finally(() => {
        Object.assign(Database, original);
    });
} catch (error) {
    Object.assign(Database, original);
    throw error;
}
