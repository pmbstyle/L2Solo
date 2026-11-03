'use strict';

const path = require('path');
const { PlayerClient, npcHtml, bypasses, carries, within } = require('./PlayerClient');

// Runs an end-to-end scenario (tests/e2e/*.js, planning/e2e-player/plan.md) with the hot scenario's
// player(s): each `step` is timed and noted in the live recorder's timeline as an "e2e" line (passed or
// failed, with the server packets around a failure); "e2e-done" closes the scenario. A script module:
//   module.exports = { name, players: 1, place(ctx) -> { locX, locY, locZ } | null, async run(ctx) }
// ctx: { players: [PlayerClient], player, step(name, fn), within, npcHtml, bypasses, carries,
//        world: { npcsNear }, setup: { giveAdena } }.
// Steps act through client packets only; `setup` prepares a player the way the game's own owner of that
// grant does (the GM's give-adena), for what a test needs but a level-1 character does not have.

function load(file) {
    return require(path.resolve(file));
}

const world = {
    // NPCs within `radius` of a place, nearest first, `filter` on the Npc.
    npcsNear(loc, radius = 1500, filter = () => true) {
        return invoke('GameServer/World/World').fetchNpcsInRadius(loc.locX, loc.locY, radius).filter(filter)
            .map(npc => ({ npc, distance: Math.hypot(npc.fetchLocX() - loc.locX, npc.fetchLocY() - loc.locY) }))
            .sort((a, b) => a.distance - b.distance).map(row => row.npc);
    }
};

const setup = {
    async giveAdena(client, amount) {
        await invoke('GameServer/World/Generics/NpcBypasses/AdminGiveAdena')(client.session,
            ['admin_give_adena', client.actor.fetchName(), String(amount)]);
    }
};

async function run(script, sessions) {
    const Recorder = invoke('Perf/LiveRecorder');
    const players = sessions.map(session => new PlayerClient(session));
    const results = [];
    const step = async (name, fn) => {
        const started = Date.now();
        try {
            const value = await fn();
            results.push({ name, ok: true, ms: Date.now() - started });
            Recorder.note('e2e', { script: script.name, step: name, ok: true, ms: Date.now() - started });
            return value;
        } catch (error) {
            const around = players[0]?.namesSince(started) || [];
            results.push({ name, ok: false, ms: Date.now() - started, error: error.message });
            Recorder.note('e2e', { script: script.name, step: name, ok: false, ms: Date.now() - started, error: error.message, packets: around });
            utils.infoWarn('Perf', 'e2e %s: step "%s" failed: %s', script.name, name, error.message);
            throw Object.assign(error, { stepFailed: true });
        }
    };
    const ctx = { players, player: players[0], step, within, npcHtml, bypasses, carries, world, setup };
    try {
        await script.run(ctx);
    } catch (error) {
        if (!error.stepFailed) {
            results.push({ name: '(script)', ok: false, error: error.message });
            Recorder.note('e2e', { script: script.name, step: '(script)', ok: false, error: error.message });
        }
    }
    const failed = results.filter(row => !row.ok).length;
    Recorder.note('e2e-done', { script: script.name, steps: results.length, failed });
    utils[failed ? 'infoWarn' : 'infoSuccess']('Perf', 'e2e %s: %d step(s), %d failed', script.name, results.length, failed);
    return results;
}

module.exports = { load, run, world };
