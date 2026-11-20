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
// restOn: the fight that leaves the bot at 1 HP with a rest the author's rest step extends.
// The hunt runs twice (the use pass, then the row): onPass counts the row's fights afresh.
function simulation(dieOn, restOn = 0) {
    const fresh = () => ({ fights: 0, respawns: [], downMs: 0, restedMs: 0 });
    const calls = fresh();
    return { calls, onPass: () => Object.assign(calls, fresh()), sim: {
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
                    if (args.state.activity === 'resting' && result.patch.activity === 'resting') {
                        calls.restedMs += result.patch.stats.restUntil - args.timestamp;
                    }
                    return result;
                }
                calls.fights += 1;
                const t = args.timestamp + FIGHT_MS;
                if (calls.fights === dieOn) {
                    // A dying round ends at the death and its respawn step is due there.
                    return { patch: { activity: 'dead', vitals: { hp: 0 } }, materialize: {},
                        debug: { died: true, wins: 0, mobsKilled: 0, combatMs: FIGHT_MS }, doneAt: t, nextResolveAt: t };
                }
                if (calls.fights === restOn) {
                    return { patch: { activity: 'resting', vitals: { hp: 1 }, stats: { ...args.state.stats, restUntil: t + 1000 } },
                        materialize: { exp: 100 }, debug: { wins: 1, mobsKilled: 1, combatMs: FIGHT_MS }, nextResolveAt: t + 1000 };
                }
                return { patch: {}, materialize: { exp: 100 },
                    debug: { wins: 1, mobsKilled: 1, combatMs: FIGHT_MS }, nextResolveAt: t };
            } }
    } };
}

const spot = { id: 'fixture', center: { locX: 0, locY: 0, locZ: 0 }, density: 1 };
const hours = 0.25;
const safe = simulation(0), deadly = simulation(3);
const calm = Generator.hunt(spot, 'dps', 20, 0, hours, safe.sim, null, undefined, safe.onPass);
const died = Generator.hunt(spot, 'dps', 20, 0, hours, deadly.sim, null, undefined, deadly.onPass);
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

// A rest the author's rest step extends is rest in the row, each extension with it
// (the fight's own rest runs from its step: its 30 s and the 1 s after).
const tired = simulation(0, 2);
const rested = Generator.hunt(spot, 'dps', 20, 0, hours, tired.sim, null, undefined, tired.onPass);
assert(tired.calls.restedMs > 0, 'the rest step extends the 1 s rest');
assert.equal(rested.restMs, FIGHT_MS + 1000 + tired.calls.restedMs, 'the row\'s rest holds the fight\'s rest and every extension of it');
assert.equal(rested.busyMs, rested.fightMs + rested.restMs, 'and its busy time with it');

// T141: the row's potions are what the game buys for a bot of that level: the
// outing's use (2 h), a bottle every fight here, whatever the deaths.
function drinker(dieAfter = Infinity) {
    let fights = 0;
    return { onPass: () => { fights = 0; }, sim: {
        items: invoke('GameServer/DataCache').items,
        BotGear: invoke('GameServer/Bot/AI/BotGear'),
        CCP: invoke('GameServer/Bot/Population/ColdCombatProfile'),
        ShotStock: invoke('GameServer/Inventory/ShotStock'),
        Potions: invoke('GameServer/Bot/AI/HealingPotionStock'),
        HuntEfficiency: { lootValue: () => 0 },
        BR: { admittedShares: () => null, admittedDensity: density => density.density,
            resolveSolo({ state, timestamp }) {
                fights += 1;
                const potion = String(invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor({ level: state.level }).selfId);
                const held = Number(state.inventory[potion]?.amount || 0);
                const drinks = held > 0 ? 1 : 0;
                const inventory = { ...state.inventory, [potion]: { ...state.inventory[potion], amount: held - drinks } };
                const died = fights === dieAfter;
                return { patch: { inventory, ...(died ? { activity: 'hunting' } : {}) }, materialize: { exp: 1 },
                    debug: { wins: 1, mobsKilled: 1, combatMs: 60000, potionsUsed: drinks, died }, nextResolveAt: timestamp + 60000 };
            } }
    } };
}
const huntOf = ({ sim, onPass }) => Generator.hunt(spot, 'dps', 20, 0, 2, sim, null, undefined, onPass);
const lean = huntOf(drinker());
assert.equal(lean.potions, 120, 'a 0-death row carries the outing\'s use too: the game buys the outing\'s refill whatever the deaths');
const dying = huntOf(drinker(5));
assert.equal(dying.potions, 120, 'a row with deaths carries the outing\'s use: a bottle every fight');
console.log('PASS spot table death time');
