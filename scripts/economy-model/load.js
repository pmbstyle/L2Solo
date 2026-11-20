'use strict';

// The model's reads of what the game and the snapshot files hold, below every
// rule and report: the snapshot a run reads (loadSnapshot), the hunt tables'
// spot cards (spotCards, parsed once per process) and the hours a death's walk
// back from a spot takes (walkBackHours, over the cards' centres). inputs.js
// builds the snapshot on top of these; kit-hours, run and compare read it
// through them.

const fs = require('fs');
const path = require('path');
const Boot = require('./boot');

// Where inputs.js writes the snapshots by default.
const SNAPSHOT_DIR = path.join(Boot.root, 'tmp', 'economy-model');

// The snapshot of a preset whose stamp equals the live game data's
// (Boot.stampMatches): the file named, else the first such in dir by name.
// None: the run refuses, with the command that builds one.
function loadSnapshot(dir, preset, file = null) {
    const build = `node scripts/economy-model/inputs.js --preset ${preset}`;
    const files = file ? [path.resolve(file)] : (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
        .filter(name => name.startsWith(`inputs-${preset}-`) && name.endsWith('.json')).sort().map(name => path.join(dir, name));
    for (const candidate of files) {
        const snapshot = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (Boot.stampMatches(snapshot.header)) return { file: candidate, snapshot };
    }
    throw new Error(file ? `${file} is not a snapshot of the live game data (its stamp differs); build one: ${build}`
        : `no inputs-${preset}-*.json in ${dir} is a snapshot of the live game data (${files.length} with another stamp); build one: ${build}`);
}

// The hunt tables' spot cards (data/Bots/hunt/spots.json, built with
// geodata), read once per process: { spotFields, spots: [row] }.
let cards = null;
function spotCards() {
    cards ||= JSON.parse(fs.readFileSync(path.join(Boot.root, 'data', 'Bots', 'hunt', 'spots.json'), 'utf8'));
    return cards;
}

// The hours a death's walk back from a spot takes: the server's own
// WalkBack.hours (the landing town's run to the spot) over the spot cards'
// centres. Offline there is no live spot catalogue, so WalkBack's default
// answers 0. 0 for a spot without a centre.
let walkSpots = null;
function walkBackHours(spotId, state = {}) {
    if (!walkSpots) {
        const table = spotCards(), at = table.spotFields.indexOf('center');
        walkSpots = table.spots.filter(row => row[at]).map(row => ({ id: row[0], center: { locX: row[at][0], locY: row[at][1], locZ: row[at][2] } }));
    }
    return require('../../src/GameServer/Bot/Economy/WalkBack').hours(spotId, state, walkSpots);
}

module.exports = { SNAPSHOT_DIR, loadSnapshot, spotCards, walkBackHours };
