'use strict';
// A seeded bot without a planned spot (a craft service's character) is
// created near a spot near its level by the spots' level mix
// (SpotProfiles.spotsNearLevel), never on low ground that holds one spawn of
// its level.
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('generated-seed-spot-level');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Database = invoke('Database');
invoke('GameServer/DataCache').init();
const Seeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');

async function run() {
    await Database.init();
    const level = CraftShopService.stationCrafter().level;
    // Four low fields with one spawn of the crafter's level each, and one
    // field four levels above it (near by its mix, past a +-3 min/max window).
    const low = [0, 1, 2, 3].map(at => ({ id: `${10 + at}_10`, minLevel: 12, maxLevel: level, avgLevel: 14, density: 21,
        levelCounts: { 12: 20, [level]: 1 }, npcEntries: [], center: { locX: 40000 + at * 20000, locY: 40000, locZ: 0 } }));
    const fit = { id: '20_20', minLevel: level + 4, maxLevel: level + 4, avgLevel: level + 4, density: 8, levelCounts: { [level + 4]: 8 },
        npcEntries: [], center: { locX: -60000, locY: -60000, locZ: 0 } };
    SpotProfiles.ensure = () => [...low, fit];

    // The row each new character is created with (the DB write; the crafter
    // moves to its Giran stall later in the pass).
    const created = [];
    const createCharacter = Database.createCharacter;
    Database.createCharacter = (username, charData) => {
        created.push({ username, ...charData });
        return createCharacter.call(Database, username, charData);
    };
    try {
        await Seeder.ensureCraftServices();
    } finally {
        Database.createCharacter = createCharacter;
    }
    assert(created.length > 0, 'the craft services are created');
    for (const row of created) {
        const distance = Math.hypot(Number(row.locX) - fit.center.locX, Number(row.locY) - fit.center.locY);
        assert(distance < 1100, `${row.username} is created at the field near its level: ${Math.round(distance)} away`);
    }
    console.log('PASS generated seed spot level: a bot is seeded near a spot of its level by the level mix');
}
run().then(() => Database.close()).catch(async error => {
    console.error(error); process.exitCode = 1; await Database.close();
});
