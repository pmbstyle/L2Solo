const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const databasePath = path.join(process.cwd(), 'tmp', 'test-cold-claim-flags.sqlite');

fs.rmSync(databasePath, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);
Database.init();

// A claim reads only the lease columns and the workflow flags. The flags must
// keep the truthiness JSON.parse gave them before. (Malformed or empty stats
// cannot be stored: the table's triggers json_extract every new statsJson.)
const cases = [
    ['{}', 'claimed'],
    ['[1,2]', 'claimed'],
    ['5', 'claimed'],
    ['{"warehouseWorkflow":{"step":1}}', 'warehouse_state'],
    ['{"warehouseWorkflow":false,"warehouseErrand":null}', 'claimed'],
    ['{"warehouseErrand":[]}', 'warehouse_state'],
    // A bot's stall state is gone with the board (step 3.3): a leftover
    // marketStore no longer holds a claim.
    ['{"marketStore":{}}', 'claimed'],
    ['{"marketReturn":"0"}', 'market_state'],
    ['{"craftStationId":""}', 'claimed'],
    ['{"craftStationId":7}', 'craft_state'],
    ['{"craftShop":true}', 'craft_state'],
    ['{"supplyErrand":{"itemId":57}}', 'player_workflow'],
    ['{"other":{"warehouseWorkflow":1},"supplyErrand":false}', 'claimed']
];

(async () => {
    await Database.createAccount('claim_probe', 'secret');
    await Database.createCharacter('claim_probe', {
        name: 'ClaimProbe', race: 0, classId: 0, maxHp: 100, maxMp: 50,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 10, locY: 20, locZ: -30
    });
    const characterId = Number((await Database.fetchCharacters('claim_probe'))[0].id);
    await Database.execute([
        `INSERT INTO bot_life_state (
            characterId, accountName, characterName, level, activity, phase,
            locX, locY, locZ, hp, maxHp, mp, maxMp, statsJson, inventorySummary, updatedAt
        ) VALUES (?, 'claim_probe', 'ClaimProbe', 20, 'hunting', 'cold', 10, 20, -30, 100, 100, 50, 50, '{}', '{}', 1000)`,
        [characterId]
    ]);

    for (const [statsJson, expected] of cases) {
        await Database.execute([`UPDATE bot_life_state SET statsJson = ?, simulationOwner = ?, simulationLeaseId = NULL,
            simulationLeaseUntil = 0 WHERE characterId = ?`, [statsJson, Owner.LEGACY_OWNER_ID, characterId]]);
        const [row] = await Database.execute(['SELECT simulationRevision FROM bot_life_state WHERE characterId = ?', [characterId]]);
        const timestamp = Date.now();
        const [result] = await Database.claimColdSimulationLeases([{
            characterId,
            expectedRevision: Number(row.simulationRevision || 0),
            ownerId: Owner.OWNER_ID,
            leaseId: `lease-${statsJson.length}`,
            timestamp,
            leaseUntil: timestamp + 30000
        }]);
        assert.strictEqual(result.reason, expected, `stats ${JSON.stringify(statsJson)}`);
        if (expected === 'claimed') assert.strictEqual(result.revision, Number(row.simulationRevision || 0) + 1);
    }

    console.log('cold claim flag tests passed');
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
