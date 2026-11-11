const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const target = process.argv[2] || path.join(__dirname, '../src/GameServer/Bot/Population/ActivationPlacement.js');
const config = { activationMinPlayerDistance: 450, activationRadius: 9000,
    activationPlacementAttempts: 8, activationPlacementRadius: 1400 };
let blocked = false, missingGeo = false, wrongFloor = false, disconnected = false;
const geo = {
    hasGeo: () => !missingGeo,
    getHeight: () => 0,
    getCellData: (x, y) => ({ z: wrongFloor ? 1000 : 0,
        nswe: !blocked && Math.abs(x) <= 160 && Math.abs(y) <= 80 ? 15 : 0 }),
    hasLineOfSight: () => !disconnected
};
const dependencies = {
    'GameServer/Bot/Population/PopulationConfig': config,
    'GameServer/Bot/AI/SpotService': { findById: () => null, findCurrentSpot: () => null },
    'GameServer/Geodata/GeodataEngine': geo,
    'GameServer/Bot/Population/PopulationMetrics': { recordWalkerRoadStepBack: () => {}, recordWalkerStartTownPlacement: () => {} },
    'GameServer/Bot/Population/PartyHuntingTarget': { competitionNpcId: () => null },
    'GameServer/Bot/AI/TownTransitPolicy': { townAt: () => null }
};
const math = Object.create(Math);
math.random = () => 0.75;
const context = { module: { exports: {} }, Math: math,
    invoke: name => { assert.ok(dependencies[name], name); return dependencies[name]; } };
vm.runInNewContext(fs.readFileSync(target, 'utf8'), context, { filename: target });
const placement = context.module.exports;
const playerLoc = { locX: 0, locY: 0, locZ: 0 };
const state = { activity: 'traveling', loc: { locX: 100000, locY: 100000, locZ: 0 } };
const options = { forceNearPlayer: true, playerLoc };
const result = placement.resolve(state, options);
assert.ok(result, 'a summoned traveler must use safe nearby space in a narrow room');
assert.ok(Math.hypot(result.loc.locX, result.loc.locY) <= 160);
assert.equal(placement.resolve({ loc: playerLoc }, { playerLoc }), null);
blocked = true;
assert.equal(placement.resolve(state, options), null);
blocked = false; missingGeo = true;
assert.equal(placement.resolve(state, options), null);
missingGeo = false; wrongFloor = true;
assert.equal(placement.resolve(state, options), null);
wrongFloor = false; disconnected = true;
assert.equal(placement.resolve(state, options), null);
disconnected = false;
assert.equal(placement.resolve(state, { ...options, keepStoreLocation: true, storeLoc: state.loc }), null);
console.log('Summoned placement: narrow room, ambient separation, collision, geodata, floor, connectivity and fixed-store guards passed.');
