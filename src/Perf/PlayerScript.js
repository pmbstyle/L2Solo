'use strict';

const path = require('path');
const { npcHtml, bypasses, carries, objectIdAt, within } = require('./PlayerClient');

// Runs an end-to-end scenario (tests/e2e/*.js; run with scripts/perf.js --scenario=script) with the hot scenario's
// player(s): each `step` is timed and noted in the live recorder's timeline as an "e2e" line (passed or
// failed, with the server packets around a failure); "e2e-done" closes the scenario. A script module:
//   module.exports = { name, players: 1, place(ctx) -> { locX, locY, locZ } | null, async run(ctx) }
// ctx: { players: [PlayerClient], player, step(name, fn), within, npcHtml, bypasses, carries, objectIdAt,
//        world: { npcsNear, bots, botsNear, crowd, failures }, setup: { giveAdena, teleport } }.
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
    },

    // Every bot's life state (BotLifeState, the cold truth and the hot rows), and those near a place.
    bots() {
        return invoke('GameServer/Bot/Population/BotLifeState').everyState();
    },

    botsNear(loc, radius) {
        return this.bots().filter(state => state.loc && Math.hypot(state.loc.locX - loc.locX, state.loc.locY - loc.locY) <= radius);
    },

    // The fullest place of cold hunters (HotCrowd's own choice of a crowd), optionally at least
    // `beyond` from a place.
    crowd({ awayFrom = null, beyond = 0 } = {}) {
        return invoke('Perf/HotCrowd').crowdLocations(this.bots(), 1000)
            .find(place => !awayFrom || Math.hypot(place.locX - awayFrom.locX, place.locY - awayFrom.locY) >= beyond) || null;
    },

    // The cold worker's fault and the commit queue's afterCommit error counts (always on).
    failures() {
        const snapshot = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').snapshot();
        return { workerFaults: snapshot.failures?.workerFaults || 0, afterCommitErrors: snapshot.queue?.failures?.afterCommitErrors || 0 };
    }
};

const setup = {
    async giveAdena(client, amount) {
        await invoke('GameServer/World/Generics/NpcBypasses/AdminGiveAdena')(client.session,
            ['admin_give_adena', client.actor.fetchName(), String(amount)]);
    },

    // Travel: the gatekeeper's teleport (tests/e2e/gatekeeper.js checks that one through its window).
    teleport(client, loc) {
        // global.path: this file's own require('path') hides the project's path map. The client then
        // says it has loaded the new place (Appeared), as a real one does.
        const moved = invoke(global.path.actor).teleportTo(client.session, client.actor, { locX: loc.locX, locY: loc.locY, locZ: loc.locZ, head: 0 });
        if (moved !== false) client.appeared().catch(() => {});
        return moved;
    }
};

// players: the PlayerClients HotCrowd logged in.
async function run(script, players) {
    const Recorder = invoke('Perf/LiveRecorder');
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
    const ctx = { players, player: players[0], step, within, npcHtml, bypasses, carries, objectIdAt, world, setup };
    try {
        if (!players.length) throw new Error('no player spawned (server.log: "hot scenario")');
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
