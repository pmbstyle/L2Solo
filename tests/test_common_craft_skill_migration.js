const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Skillset = invoke('GameServer/Actor/Skillset');

DataCache.init();

const original = {
    fetchSkills: Database.fetchSkills,
    setSkill: Database.setSkill
};
const storedByCharacter = new Map([
    [9101, [{ selfId: 194, name: 'Lucky', passive: 1, level: 1, characterId: 9101 }]],
    [9102, []]
]);
let writes = 0;

function storedSkills(characterId) {
    return storedByCharacter.get(characterId) || [];
}

Database.fetchSkills = (characterId) => Promise.resolve(storedSkills(characterId).map((skill) => ({ ...skill })));
Database.setSkill = (skill, characterId) => {
    writes += 1;
    const stored = storedSkills(characterId);
    const existing = stored.find((entry) => entry.selfId === skill.selfId);
    if (existing) Object.assign(existing, skill);
    else stored.push({ ...skill, characterId });
    storedByCharacter.set(characterId, stored);
    return Promise.resolve();
};

function actor(characterId, level) {
    return {
        fetchId: () => characterId,
        fetchLevel: () => level
    };
}

(async () => {
    try {
        const veteranSkills = new Skillset();
        await veteranSkills.populateForActor(actor(9101, 70));

        assert.strictEqual(storedSkills(9101).find((skill) => skill.selfId === 1322)?.level, 1,
            'an existing character should receive Common Craft on login');
        assert.strictEqual(storedSkills(9101).find((skill) => skill.selfId === 1320)?.level, 9,
            'an existing level 70 character should receive the sourced common-craft mastery level');
        assert.strictEqual(veteranSkills.fetchSkill(1322)?.fetchLevel(), 1,
            'the reconciled Common Craft skill should be available in the live skillset');
        assert.strictEqual(veteranSkills.fetchSkill(1320)?.fetchLevel(), 9,
            'the reconciled mastery should be available before the client skill refresh');

        writes = 0;
        await veteranSkills.populateForActor(actor(9101, 70));
        assert.strictEqual(writes, 0, 'automatic-skill reconciliation should not rewrite an up-to-date character');

        const noviceSkills = new Skillset();
        await noviceSkills.populateForActor(actor(9102, 4));
        assert.strictEqual(storedSkills(9102).find((skill) => skill.selfId === 1322)?.level, 1,
            'Common Craft should be present from level 1');
        assert.strictEqual(storedSkills(9102).some((skill) => skill.selfId === 1320), false,
            'Create Common Item should not be granted before sourced level 5');

        console.log('Common craft skill migration checks passed');
    }
    finally {
        Object.assign(Database, original);
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
