const assert = require('assert');

require('../src/Global');

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GeneratedColdSeeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');

const starterRegions = ['human', 'elf', 'dark_elf', 'orc', 'dwarf'];
starterRegions.forEach((starterRegion) => {
    const variantsByClass = new Map();
    for (let index = 2000000; index < 2001000; index++) {
        const base = GeneratedColdSeeder.baseForIndex(index, starterRegion);
        if (!variantsByClass.has(base.classId)) variantsByClass.set(base.classId, new Set());
        variantsByClass.get(base.classId).add(base.sex);
    }
    variantsByClass.forEach((variants, classId) => {
        assert.deepStrictEqual([...variants].sort(), [0, 1],
            `${starterRegion} class ${classId} must generate both character sexes`);
    });
});

assert.strictEqual(
    GeneratedColdSeeder.sexForIndex(123456),
    GeneratedColdSeeder.sexForIndex(123456),
    'generated appearance must remain deterministic across restarts'
);

const originalAcceptAppearanceMetadata = LifeState.acceptAppearanceMetadata;
const stateUpdates = [];

LifeState.acceptAppearanceMetadata = (characterId, sex, appearanceVersion) => {
    stateUpdates.push({ characterId, sex, appearanceVersion });
    return Promise.resolve({ characterId, stats: { sex, appearanceVersion } });
};

(async () => {
    const candidates = [
        { characterId: 11, stats: { generatedCold: true, generatedIndex: 700 } },
        { characterId: 12, stats: { generatedCold: true, generatedIndex: 10003, appearanceVersion: 1 } },
        { characterId: 13, stats: { generatedCold: true, generatedIndex: 701, appearanceVersion: GeneratedColdSeeder.APPEARANCE_VERSION } },
        { characterId: 14, stats: { generatedCold: false, generatedIndex: 702 } },
        { characterId: 15, stats: { generatedCold: true } }
    ];

    const migrated = await GeneratedColdSeeder.migratePopulationAppearances(candidates);
    assert.strictEqual(migrated, 2, 'only stale generated appearances must be migrated');
    assert.deepStrictEqual(stateUpdates, [
        { characterId: 11, sex: GeneratedColdSeeder.sexForIndex(700), appearanceVersion: GeneratedColdSeeder.APPEARANCE_VERSION },
        { characterId: 12, sex: GeneratedColdSeeder.sexForIndex(10003), appearanceVersion: GeneratedColdSeeder.APPEARANCE_VERSION }
    ], 'the seeder must delegate durable migration and cache reflection to the serialized lifecycle path');

    console.log('Generated population appearance checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    LifeState.acceptAppearanceMetadata = originalAcceptAppearanceMetadata;
});
