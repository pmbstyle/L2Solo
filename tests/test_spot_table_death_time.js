'use strict';
// A death in the spot table's hunt costs what it costs a live cold bot: the
// author's respawn (BackgroundResolver resolveDeathRecovery) runs on the
// hunt's clock, so the hour of a deadly spot holds fewer kills; its exp loss
// stays for the reader to charge per death (EconomicValuation.deathHours).
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Generator = require('../scripts/generate-spot-table');
const BR = invoke('GameServer/Bot/Population/BackgroundResolver');

const FIGHT_MS = 30000;
// The fight is the edge: a won kill every 30 s, or a death on the fight
// named; every other step (the respawn, the rest after it) is the author's.
function simulation(dieOn) {
    const calls = { fights: 0, respawns: [], downMs: 0 };
    return { calls, sim: {
        items: invoke('GameServer/DataCache').items,
        BotGear: invoke('GameServer/Bot/AI/BotGear'),
        CCP: invoke('GameServer/Bot/Population/ColdCombatProfile'),
        ShotStock: invoke('GameServer/Inventory/ShotStock'),
        Potions: invoke('GameServer/Bot/AI/HealingPotionStock'),
        HuntEfficiency: { lootValue: () => 0 },
        BR: { admittedShares: () => null, admittedDensity: spot => spot.density,
            resolveSolo(args) {
                if (args.state.activity !== 'hunting') {
                    const result = BR.resolveSolo(args);
                    if (result.debug?.respawnDelayMs) calls.respawns.push(result.debug.respawnDelayMs);
                    calls.downMs += result.nextResolveAt - args.timestamp;
                    return result;
                }
                calls.fights += 1;
                const t = args.timestamp + FIGHT_MS;
                if (calls.fights === dieOn) {
                    return { patch: { activity: 'dead', vitals: { hp: 0 } }, materialize: {},
                        debug: { died: true, wins: 0, mobsKilled: 0, combatMs: FIGHT_MS }, nextResolveAt: t };
                }
                return { patch: {}, materialize: { exp: 100 },
                    debug: { wins: 1, mobsKilled: 1, combatMs: FIGHT_MS }, nextResolveAt: t };
            } }
    } };
}

const spot = { id: 'fixture', center: { locX: 0, locY: 0, locZ: 0 }, density: 1 };
const hours = 0.25;
const safe = simulation(0), deadly = simulation(3);
const calm = Generator.hunt(spot, 'dps', 20, 0, hours, safe.sim);
const died = Generator.hunt(spot, 'dps', 20, 0, hours, deadly.sim);
assert.equal(calm.deaths, 0);
assert.equal(died.deaths, 1, 'the death is counted once');
assert.equal(deadly.calls.respawns.length, 1, 'the author\'s respawn ran');
const [respawnMs] = deadly.calls.respawns;
assert(respawnMs > 0, 'the respawn has its delay');
// The lost time: the dying fight, the respawn and the author's steps after
// it until the bot hunts again, each 30 s a kill not made.
assert(deadly.calls.downMs >= respawnMs);
const lost = calm.kills - died.kills;
assert.equal(lost, 1 + Math.ceil(deadly.calls.downMs / FIGHT_MS), `kills lost to the death: ${lost} (down ${deadly.calls.downMs} ms)`);
assert.equal(died.exp, died.kills * 100, 'the exp is the kills\' (the loss is the reader\'s)');
console.log('PASS spot table death time');
