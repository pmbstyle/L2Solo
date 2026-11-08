'use strict';

const assert = require('assert');
const Intake = require('../src/GameServer/Bot/Population/PopulationIntakePolicy');
const Types = require('../src/GameServer/Bot/AI/BotPersonaTypes');
const Progression = require('../src/GameServer/ClassProgression');

const pool = [{ race: 0, classId: 0, role: 'dps' }, { race: 0, classId: 10, role: 'mage' }];
const saturated = Object.fromEntries(Types.TYPE_IDS.map((id) => [id, 1000]));
saturated.steadfast_helper = 0;
let helpers = 0, helperMages = 0, mages = 0;
for (let seed = 0; seed < 1000; seed++) {
    // A human region with 30 fighters and no mystic: the mix gives mystics 4 of its 22.
    const options = { typeCounts: saturated, total: 150, classTotal: 30, classCounts: { 0: 30, 10: 0 } };
    const chosen = Intake.choose(pool, seed, options);
    if (chosen.classId === 10) mages++;
    if (chosen.archetype === 'steadfast_helper') {
        helpers++;
        if (chosen.classId === 10) helperMages++;
    }
    const dwarf = Intake.choose([{ race: 4, classId: 53 }], seed, options);
    assert.strictEqual(Types.TYPES[dwarf.archetype].drive, 'wealth');
    assert.notStrictEqual(chosen.archetype, 'patient_crafter');
}
assert(mages > 800, 'newcomers fill the missing class of the region\'s mix first');
assert(helpers > 600, 'then the missing type its class may take');
assert(helperMages / helpers > 0.9, 'the support type lands on the support class');

// A generated cohort follows the class mix (fresh world, 1500 bots): the regions by
// their races' weights, the classes by their weights, the professions split evenly.
{
    require('../src/Global');
    const Prog = invoke('GameServer/Bot/BotClassProgression');
    const race = { 0: 0, 10: 0, 18: 1, 25: 1, 31: 2, 38: 2, 44: 3, 49: 3, 53: 4 };
    const starts = Object.keys(race).map(Number);
    const regions = ['human', 'elf', 'dark_elf', 'orc', 'dwarf'];
    const shares = Intake.raceShares();
    const totals = regions.map((region, index) => Math.round(1500 * shares[index]));
    const typeCounts = {}, classCounts = {}, kinds = { dd: 0, healer: 0, buffer: 0, dwarf: 0 };
    let index = 0;
    regions.forEach((region, at) => {
        const regionPool = starts.filter((classId) => race[classId] === at).map((classId) => ({ race: at, classId }));
        for (let n = 0; n < totals[at]; n++, index++) {
            const chosen = Intake.choose(regionPool, index, { typeCounts, classCounts, total: 1500, classTotal: totals[at] });
            typeCounts[chosen.archetype] = (typeCounts[chosen.archetype] || 0) + 1;
            classCounts[chosen.classId] = (classCounts[chosen.classId] || 0) + 1;
            const seed = 3000000 + index, first = Prog.nextClass(chosen.classId, 20, seed) ?? chosen.classId;
            const second = Prog.nextClass(first, 40, seed) ?? first;
            kinds[at === 4 ? 'dwarf' : [16, 30, 43].includes(second) ? 'healer' : [17, 51, 52].includes(second) ? 'buffer' : 'dd']++;
        }
    });
    const share = (kind) => 100 * kinds[kind] / index;
    for (const [kind, target] of Object.entries({ dd: 75, healer: 7, buffer: 6, dwarf: 12 }))
        assert(Math.abs(share(kind) - target) <= 2, `${kind} ${share(kind).toFixed(1)} % of a new cohort, the mix says ~${target} %`);
}
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
        assert.deepStrictEqual(plan.regionalTargets, { human: 33, elf: 33, dark_elf: 35, orc: 31, dwarf: 18 },
            'a wave splits across the regions by their races\' share of the class mix');
        console.log('Population intake: class mix, class-first deficits, type circles, canonical persona, wave cap and race constraints passed');
    } finally {
        Database.execute = execute;
        Persona.reset();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
