'use strict';

const assert = require('assert');
const Intake = require('../src/GameServer/Bot/Population/PopulationIntakePolicy');
const Types = require('../src/GameServer/Bot/AI/BotPersonaTypes');
const Progression = require('../src/GameServer/ClassProgression');

const pool = [{ race: 0, classId: 0, role: 'dps' }, { race: 0, classId: 10, role: 'mage' }];
const saturated = Object.fromEntries(Types.TYPE_IDS.map((id) => [id, 1000]));
saturated.steadfast_helper = 0;
let helpers = 0;
let helperMages = 0;
for (let seed = 0; seed < 1000; seed++) {
    const options = { typeCounts: saturated, total: 150, classTotal: 30, classCounts: { 0: 30, 10: 0 } };
    const chosen = Intake.choose(pool, seed, options);
    const reverse = Intake.choose(pool, seed, { ...options, classCounts: { 0: 0, 10: 30 } });
    assert.strictEqual(chosen.archetype, reverse.archetype, 'class deficits must not choose the type retroactively');
    if (chosen.archetype === 'steadfast_helper') {
        helpers++;
        if (chosen.classId === 10) helperMages++;
    }
    const dwarf = Intake.choose([{ race: 4, classId: 53 }], seed, options);
    assert.strictEqual(Types.TYPES[dwarf.archetype].drive, 'wealth');
    assert.notStrictEqual(chosen.archetype, 'patient_crafter');
}
assert(helpers > 750, 'newcomers must strongly address the missing type');
assert(helperMages / helpers > 0.98, 'the available support circle and regional class deficit should favor mages');
assert.deepStrictEqual(Intake.classCounts([
    { accountName: 'bot_pop_a', stats: { classId: 98 } },
    { accountName: 'bot_pop_b', stats: { classId: 7 } },
    { accountName: 'bot_pop_c', stats: { classId: 57 } },
    { accountName: 'bot_craft_station', stats: { classId: 57 } }
], Progression), { 0: 1, 10: 1, 53: 1 });

require('../src/Global');
const Persona = invoke('GameServer/Bot/AI/BotPersona');
const Seeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');
const Planner = invoke('GameServer/Bot/Population/PopulationSeedPlanner');
const Database = invoke('Database');

async function main() {
    const execute = Database.execute;
    const writes = [];
    try {
        Persona.reset();
        Database.execute = async ([sql, params]) => {
            if (sql.startsWith('INSERT INTO bot_personas')) writes.push(params);
            return [];
        };
        const base = Seeder.baseForIndex(20, 'human', { typeCounts: saturated, total: 150,
            classTotal: 30, classCounts: { 0: 30 } });
        assert.strictEqual(base.race, 0);
        const state = { characterId: 410000, stats: { classId: base.classId, generatedIndex: 20 } };
        const persona = await Persona.ensure(state, { archetype: base.archetype });
        assert.strictEqual(persona.archetype, base.archetype);
        assert.strictEqual(writes.length, 1);
        assert.strictEqual(writes[0][4], base.archetype, 'the selected type is the canonical persisted persona');
        assert.strictEqual(await Persona.ensure(state, { archetype: 'brawler' }), persona);
        assert.strictEqual(writes.length, 1, 'an existing persona is preserved');
        const dwarf = Persona.generate({ characterId: 410001, classId: 53 }, { archetype: 'brawler' });
        assert.strictEqual(dwarf.primaryDrive, 'wealth', 'a requested type cannot bypass dwarf constraints');
        const profiles = Planner.STARTER_REGIONS.map((region) => ({ id: region.id, minLevel: 1,
            avgLevel: 1, center: region.center }));
        const plan = Planner.plan(profiles, [], 1700, 30);
        assert.strictEqual(plan.missing.length, 150);
        assert.strictEqual(plan.wave, 1);
        assert.deepStrictEqual(plan.regionalTargets, { human: 30, elf: 30, dark_elf: 30, orc: 30, dwarf: 30 });
        console.log('Population intake: type-first deficits, class circles/regional deficits, canonical persona, old wave cap and race constraints passed');
    } finally {
        Database.execute = execute;
        Persona.reset();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
