'use strict';
// The model's hunt table reader: a bot hunts only the species of a spot that
// kill it at most once in so many kills (the limit moves the row without a
// rebuild, and a spot with none reads 'cannot hunt here'); the species it
// hunts combine on time (each one's measured walk brought to their joint density, kills capped by their
// production as the game caps a cold solo bot), not by summing their kills, and one species alone reads back
// its own cell; the hour's exp carries the C4
// level-gap penalty once per species and the preset's exp rate.
const assert = require('node:assert/strict');
const HuntRows = require('../scripts/economy-model/rules/hunt-rows');
const { gapFactor } = require('../src/GameServer/Progression/MobExperience');

const FIELDS = ['kills', 'deaths', 'fight', 'rest', 'other', 'walk', 'exp', 'shots', 'potions', 'pull'];
const NONE = [0, null, null, null, null, null, null, null, null, null];
// Per form [bare, shots]: kills an hour, then per kill deaths, fight, rest, other, walk (s), exp, shots, potions, pull;
// as the table's cells, fight + rest + other + walk is the hour over its kills.
const file = {
    fields: FIELDS, forms: ['bare', 'shots'],
    bodies: { 'k|10|7/54': { classId: 10, runSpd: 120, reach: 40, point: { attack: 7, defence: 54 } } },
    spots: {
        a: { area: 1e6, density: 20, species: { 1: { level: 8, count: 3, production: 600 }, 2: { level: 2, count: 1, production: 200 },
            9: { level: 30, count: 1, production: 100 } } },
        b: { area: 1e6, density: 10, species: { 3: { level: 10, count: 2, production: 30 } } }
    },
    cells: { 'k|10|7/54': {
        a: { 1: [[72, 0.1, 15, 25, 4, 6, 100, 0, 0.2, 1], [90, 0.1, 10, 20, 4, 6, 100, 1.5, 0.1, 1]],
            2: [[180, 0.5, 6, 8, 2, 4, 30, 0, 0, 2], [150, 0.2, 4, 6, 2, 12, 30, 1, 0, 2]] },
        b: { 3: [NONE, [300, 0, 3, 3, 0, 6, 50, 1, 0, 1]] }
    } }
};
const speciesYields = {
    '1@10@0': { drop: { 57: 10, 100: 0.5 }, spoil: {} },
    '2@10@0': { drop: { 57: 2 }, spoil: { 200: 1 } },
    '3@10@0': { drop: { 57: 100 }, spoil: {} }
};
const items = { 100: { npcBuy: 40 }, 200: { npcBuy: 7 } };
const rates = { exp: 3 };
const lines = limit => HuntRows.lineRows({ file, key: 'k', level: 10, point: { attack: 7, defence: 54 }, limit, rates, speciesYields,
    spoilLevel: 0, items, gapFactor });
const read = limit => lines(limit).rows;
const close = (actual, expected, what) => assert(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${what}: ${actual} vs ${expected}`);
const spotA = { spot: file.spots.a, cells: file.cells['k|10|7/54'].a, fields: FIELDS };

// Species 1 kills a bot once in 10 kills, species 2 once in 5 (firing shots).
assert.deepEqual(HuntRows.spotHour({ ...spotA, form: 1, limit: 0.05 }), { hour: null, reason: 'cannot_hunt' }, 'every species over the limit: cannot hunt here');
assert.deepEqual(read(0.05).map(row => row.spotId), ['b'], 'no row for a spot the bot cannot hunt in either form');
assert.deepEqual(lines(0.05).cannot, [{ spotId: 'a', form: 'shots', reason: 'cannot_hunt' }, { spotId: 'a', form: 'bare', reason: 'cannot_hunt' },
    { spotId: 'b', form: 'bare', reason: 'cannot_hunt' }], 'each spot and form it cannot hunt, with the reason');
assert.throws(() => HuntRows.lineRows({ file, key: 'k', level: 11, point: { attack: 7, defence: 54 }, rates, speciesYields, spoilLevel: 0, items, gapFactor }),
    /no body k\|11\|7\/54/, 'a body the table lacks is refused, not read as no spot');

// Species 1 alone reads back its own cell: its measured kills, and its fight, rest and walk a kill as the busy time.
const alone = read(0.15).find(row => row.spotId === 'a');
const aloneHour = HuntRows.spotHour({ ...spotA, form: 1, limit: 0.15 }).hour;
assert.deepEqual([aloneHour.kills, aloneHour.busy], [90, 10 + 20 + 6], 'species 1 alone: its measured kills, fight, rest and walk a kill');
assert.equal(alone.kills, 90);
assert.deepEqual(alone.mix, { 1: 1 });

// Both species: each one's walk was measured at its own density (3 and 1 of the spot's 5 mobs); at their joint
// density (4 of 5) it shortens as the game's walk to the nearest mob does, by the square root of the density.
const rows = read(0.25), both = rows.find(row => row.spotId === 'a');
const walk1 = 6 * Math.sqrt(3 / 4), walk2 = 12 * Math.sqrt(1 / 4);
const kills = 3600 / (0.75 * (10 + 20 + 4 + walk1) + 0.25 * (4 + 6 + 2 + walk2));
close(both.kills, kills, 'two species combine on time, drawn by their share, with the walk at their joint density');
assert.notEqual(Math.round(both.kills), 90 + 150, 'not their kills summed');
close(both.deaths, kills * (0.75 * 0.1 + 0.25 * 0.2), 'deaths an hour');
assert.deepEqual(both.mix, { 1: 0.75, 2: 0.25 });
close(both.exp, kills * (0.75 * 100 * gapFactor(2) + 0.25 * 30 * gapFactor(8)) * 3, 'exp: the level-gap penalty per species once, times the exp rate');
assert(gapFactor(8) < 1 && gapFactor(2) === 1, 'the gap of 8 is penalised');
close(both.adena, kills * (0.75 * 10 + 0.25 * 2), 'adena from the species\' yields');
close(both.dropLoot, kills * 0.75 * 0.5 * 40, 'drops at the NPC\'s price');
close(both.spoilLoot, kills * 0.25 * 7, 'spoils at the NPC\'s price');
close(both.loot, both.dropLoot + both.spoilLoot, 'loot');
close(both.shots, kills * (0.75 * 1.5 + 0.25 * 1), 'shots an hour');
close(both.busyShare, Math.min(1, kills * (0.75 * (30 + walk1) + 0.25 * (10 + walk2)) / 3600), 'busy share');
// Bare, species 2 kills it once in 2 kills: the bare hour is species 1 alone, with its own deaths.
close(both.shotless.kills, 72, 'the bare hour hunts species 1 alone, at its bare cell\'s kills');
close(both.shotless.deaths, both.shotless.kills * 0.1, 'the bare hour carries its own deaths');
assert.deepEqual(both.shotless.mix, { 1: 1 });
assert.notDeepEqual(alone, both, 'the limit moved the row on the same file');

const capped = rows.find(row => row.spotId === 'b');
assert.equal(capped.kills, 30, 'kills capped by the species\' production');
assert.equal(capped.shotless.kills, 0, 'the zero hour where the bot kills nothing bare');

// The cap as the game's soloShareMobs: a species without production adds none and does not lift the cap; a spot
// whose production is 0 (no respawn data) is not capped.
const one = [1, 0, 3, 3, 0, 6, 50, 1, 0, 1];
const capOf = species => HuntRows.combine({ spot: { area: 1e6, density: 10, species }, cells: { 3: [one, one], 4: [one, one] },
    form: 1, fields: FIELDS, admitted: ['3', '4'] }).kills;
assert.equal(capOf({ 3: { level: 10, count: 1, production: 30 }, 4: { level: 10, count: 1, production: null } }), 30, 'a species without production keeps the cap');
close(capOf({ 3: { level: 10, count: 1, production: 0 }, 4: { level: 10, count: 1, production: 0 } }), 3600 / (6 + 6 * Math.sqrt(0.5)), 'production 0: no cap');

console.log('economy model hunt rows ok');
