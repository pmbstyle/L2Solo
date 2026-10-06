const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const GeneratedColdSeeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');

DataCache.init();

const original = {
    fetchSkill: Database.fetchSkill,
    fetchSkills: Database.fetchSkills,
    learnBotSkill: Database.learnBotSkill,
    setSkill: Database.setSkill,
    updateSkillLevel: Database.updateSkillLevel
};
const stored = [];

try {
    Database.fetchSkill = (characterId, selfId) => Promise.resolve(stored.filter((skill) => skill.selfId === selfId));
    Database.fetchSkills = () => Promise.resolve(stored);
    // Funded seeder/tree contract; actual SP/books use the native book fixture.
    Database.learnBotSkill = (characterId, selfId, level) => {
        const definition = DataCache.skills.find((skill) => skill.selfId === selfId);
        const skill = stored.find((entry) => entry.selfId === selfId);
        if (skill) skill.level = level;
        else stored.push({ selfId, level, name: definition.template?.name, passive: definition.template?.passive });
        return Promise.resolve({ learned: true, spentSp: 0, consumedBooks: [] });
    };
    Database.setSkill = (skill) => {
        stored.push({ selfId: skill.selfId, name: skill.name, level: skill.level, passive: skill.passive });
        return Promise.resolve();
    };
    Database.updateSkillLevel = (characterId, selfId, level) => {
        const skill = stored.find((entry) => entry.selfId === selfId);
        if (skill) skill.level = level;
        return Promise.resolve();
    };

    GeneratedColdSeeder.awardProfileSkills(1, 38, 16).then(() => {
        assert.ok(stored.some((skill) => skill.selfId === 1040), 'a level 16 Dark Wizard should receive Shield from its class tree');
        assert.ok(stored.some((skill) => skill.selfId === 1011), 'a level 16 Dark Wizard should receive its available heal skill');
        assert.ok(stored.some((skill) => skill.selfId === 1206), 'a level 16 Dark Wizard should receive Wind Shackle from its class tree');
        console.log('Generated cold skill checks passed');
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
