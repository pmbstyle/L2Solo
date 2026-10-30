'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('../src/Global');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Rewards = require('../src/GameServer/Bot/Economy/SpotRewardExpectation');
const original = Rewards.value;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'income-bands-'));
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/spot_table.json'), 'utf8'));
// Forty active level bands exceed the old 32768 full-object cache. A new
// consumable quote must price those bands without measuring every spot again.
// Camps spread over levels 16-63: a band sees only camps inside the deep-blue gap.
const sourceSpot = raw.spots[0], sourceRows = raw.rows[0];
raw.spots = Array.from({ length: 4000 }, (_, i) => [`camp-${i}`, 16 + i % 48, ...sourceSpot.slice(2)]);
raw.rows = raw.spots.map(() => sourceRows);
const file = path.join(scratch, 'table.json');
fs.writeFileSync(file, JSON.stringify(raw));
let forecasts = 0;
try {
    Table.useFile(file);
    Table.useSpots(raw.spots.map(([id]) => ({ id })));
    Rewards.value = spot => { forecasts++; return { adena: 100 + Number(spot.id.slice(5)), drop: 5, spoil: 0 }; };
    for (let level = 24; level < 64; level++) Table.rankedIncome('dps', level, { shots: 0, potions: 0 }, -100, true);
    assert(forecasts > 32768, `the first pass measures all forty active bands past the old cache, got ${forecasts}`);
    forecasts = 0;
    const answers = [];
    for (let level = 24; level < 64; level++) {
        const costs = { shots: .123456, potions: 2.765432 };
        answers.push({ level, costs, rows: Table.rankedIncome('dps', level, costs, -100, true) });
    }
    assert(forecasts <= 40 * 64, `new quotes should need at most their selected rows, got ${forecasts} forecasts`);
    for (const { level, costs, rows } of answers) {
        const expected = raw.spots.map(([spotId]) => {
            const row = Table.value(spotId, 'dps', level, true);
            return row && { ...row, income: row.adena + row.loot - row.shots * costs.shots - row.potions * costs.potions,
                spotId, useShots: true };
        }).filter(row => row?.income > 0).sort((a, b) => b.income - a.income || a.spotId.localeCompare(b.spotId)).slice(0, 64);
        assert.deepEqual(rows, expected, 'compact rankings preserve the full scan, precise quotes and all measured fields');
        assert(Object.isFrozen(rows) && rows.every(Object.isFrozen));
    }
    console.log('spot income band cache PASS: 40 active bands retain forecasts and exact full-scan rankings');
} finally {
    Rewards.value = original; Table.useSpots([]); Table.useFile();
    fs.rmSync(scratch, { recursive: true, force: true });
}
