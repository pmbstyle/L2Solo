'use strict';

const { performance } = require('perf_hooks');

// The players of a window run (scripts/perf/window.js sets L2NODE_PERF_SCENARIO):
// - hot: players stand where the most cold bots hunt, and the population's own activation heats the
//   crowd around them (activateNearPlayers counts these sessions as real players: not a BotSession,
//   account not bot_*). The bots become hot by the path a real player causes; nothing here ticks them.
//   L2NODE_PERF_PLAYERS players, each at another of the fullest places (two activation radii apart, so
//   their crowds do not merge); L2NODE_PERF_ROUTE places on a route, every L2NODE_PERF_ROUTE_MINUTES
//   each player teleports (the gatekeeper's teleport, then Appeared) to the next one, so crowds cool
//   behind them and heat ahead: the cold <-> hot transitions a moving player causes.
// - script: an end-to-end scenario (src/Perf/PlayerScript) plays the player(s), started by the
//   runner's "script" request when the window opens.
// A player is the server's own Session on a socket that only counts what is written to it, logged in
// by its client packets (PlayerClient.login: protocol, account, character, selection, EnterWorld),
// so every per-player cost of the real path runs: the world entry, packing, character / NPC /
// ground-item visibility, the bots' broadcasts written to the player's socket. Like a real client
// each sends ValidatePosition once a second. A probe times how late a 50 ms timer fires (the event
// loop a player's packet waits for, no packet sent) and the ValidatePosition handler. Every 30 s a
// "player" line goes to the live recorder's timeline: probe samples, packets and bytes written to the
// players' sockets, moves, hot bots.

const ACCOUNT = 'perf_player';
const PROBE_MS = 50;
const POSITION_MS = 1000;
const FLUSH_MS = 30000;
// Bots are grouped in cells this wide to find the crowds.
const CELL = 3000;

const envNumber = (name, fallback, min, max) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
};

// The client end of a player: takes the packed packets the server writes and counts them.
function countingSocket() {
    return { packets: 0, bytes: 0, remoteAddress: '127.0.0.1', remotePort: 0, destroyed: false,
        write(buffer) { this.packets += 1; this.bytes += buffer?.length || 0; return true; },
        on() { return this; }, once() { return this; }, end() {}, destroy() { this.destroyed = true; }, setNoDelay() {} };
}

// The fullest cells of cold hunting bots, fullest first, each at least `apart` from the ones taken;
// a place is a bot's own location in its cell (a point on walkable ground).
function crowdLocations(states, count = 1, apart = 0) {
    const cells = new Map();
    for (const state of states) {
        const loc = state.loc;
        if (state.phase !== 'cold' || state.activity !== 'hunting' || !Number.isFinite(Number(loc?.locX))) continue;
        const key = `${Math.floor(loc.locX / CELL)}:${Math.floor(loc.locY / CELL)}`;
        const cell = cells.get(key) || { count: 0, loc };
        cell.count += 1;
        cells.set(key, cell);
    }
    const places = [];
    for (const cell of [...cells.values()].sort((a, b) => b.count - a.count)) {
        if (places.length >= count) break;
        if (places.some(place => Math.hypot(place.locX - cell.loc.locX, place.locY - cell.loc.locY) < apart)) continue;
        places.push({ locX: cell.loc.locX, locY: cell.loc.locY, locZ: cell.loc.locZ, bots: cell.count });
    }
    return places;
}

function crowdLocation(states) {
    return crowdLocations(states, 1)[0] || null;
}

const HotCrowd = {
    started: false,
    players: [],
    clients: [],

    start() {
        const scenario = process.env.L2NODE_PERF_SCENARIO;
        if (!['hot', 'script'].includes(scenario) || this.started) return;
        this.started = true;
        this.script = scenario === 'script' ? invoke('Perf/PlayerScript').load(process.env.L2NODE_PERF_SCRIPT) : null;
        const players = Number(this.script?.players ?? process.env.L2NODE_PERF_PLAYERS);
        this.count = Number.isFinite(players) ? Math.max(1, Math.min(20, Math.floor(players))) : 1;
        this.routeStops = envNumber('L2NODE_PERF_ROUTE', 0, 0, 50);
        this.routeMs = envNumber('L2NODE_PERF_ROUTE_MINUTES', 3, 1, 120) * 60000;
        this.loggedIn = new Promise(resolve => { this.onLoggedIn = resolve; });
        // The runner asks for the script when its window opens; the request is done when the script is.
        if (this.script) {
            invoke('Perf/LiveRecorder').on('script', () => this.loggedIn.then(() => invoke('Perf/PlayerScript').run(this.script, this.clients)));
        }
        const timer = setInterval(() => {
            const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
            if (!Coordinator.ready || !Coordinator.snapshotsLoaded) return;
            clearInterval(timer);
            this.place().catch(error => utils.infoWarn('Perf', 'players: %s', error.message)).finally(() => this.onLoggedIn());
        }, 1000);
    },

    async place() {
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const Config = invoke('GameServer/Bot/Population/PopulationConfig');
        const own = this.script?.place?.() || null;
        this.stops = own ? [own] : crowdLocations(LifeState.everyState(), Math.max(this.count, this.routeStops),
            2 * Number(Config.activationRadius));
        if (!this.stops.length) throw new Error('no cold hunting bot to stand by');
        utils.infoSuccess('Perf', '%s: %d player(s), %d place(s)%s: %s', this.script ? `script ${this.script.name}` : 'hot scenario',
            this.count, this.stops.length, this.routeStops ? `, moving every ${this.routeMs / 60000} min` : '',
            this.stops.map(stop => `${stop.locX},${stop.locY}${stop.bots ? ` (${stop.bots} cold hunters)` : ''}`).join('; '));
        this.step = 0;
        const Session = invoke('GameServer/Session');
        const { PlayerClient } = require('./PlayerClient');
        for (let index = 0; index < this.count; index++) {
            const client = new PlayerClient(new Session(countingSocket()));
            try {
                await client.login({ account: `${ACCOUNT}${index + 1}`, name: `PerfPlayer${index + 1}`,
                    place: this.stops[index % this.stops.length] });
            } catch (error) {
                utils.infoWarn('Perf', 'player %d did not log in: %s', index + 1, error.message);
                continue;
            }
            this.clients.push(client);
            this.players.push(client.session);
        }
        if (!this.clients.length) throw new Error('no player logged in');
        this.probe();
        if (this.routeStops > 1) setInterval(() => this.move(), this.routeMs).unref?.();
    },

    // A player killed at a crowd revives where it fell (as a real one would, back from town) before
    // it moves on: a dead actor cannot teleport, and the route would stop with nobody noticing.
    move() {
        this.step += 1;
        const Generics = invoke(path.actor);
        this.clients.forEach((client, index) => {
            if (client.actor.isDead()) {
                this.deaths = (this.deaths || 0) + 1;
                Generics.revive(client.session, client.actor, { delayMs: 0, restoreFullVitals: true });
            }
            const stop = this.stops[(index + this.step) % this.stops.length];
            if (Generics.teleportTo(client.session, client.actor, { locX: stop.locX, locY: stop.locY, locZ: stop.locZ, head: 0 }) !== false) {
                this.moves = (this.moves || 0) + 1;
                client.appeared().catch(() => {});
            } else this.failedMoves = (this.failedMoves || 0) + 1;
        });
    },

    probe() {
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const Recorder = invoke('Perf/LiveRecorder');
        const round = (ms) => Math.round(ms * 10) / 10;
        let schedule = [], handler = [], errors = 0, expected = performance.now() + PROBE_MS;
        let sent = { packets: 0, bytes: 0 };
        // How late a timer fires: the wait a player's packet has for the event loop.
        setInterval(() => {
            const now = performance.now();
            schedule.push(round(Math.max(0, now - expected)));
            expected = now + PROBE_MS;
        }, PROBE_MS).unref?.();
        // ValidatePosition once a second from every player, as a client sends it; the first one's is timed.
        setInterval(() => {
            this.clients.forEach((client, index) => {
                const began = performance.now();
                client.validatePosition().then(() => {
                    if (index === 0) handler.push(round(performance.now() - began));
                }, () => { errors += 1; });
            });
        }, POSITION_MS).unref?.();
        setInterval(() => {
            const packets = this.players.reduce((sum, player) => sum + player.socket.packets, 0);
            const bytes = this.players.reduce((sum, player) => sum + player.socket.bytes, 0);
            Recorder.note('player', { scheduleMs: schedule, handlerMs: handler, errors, hot: LifeState.counts().hot,
                players: this.players.length, wanted: this.count, packets: packets - sent.packets, bytes: bytes - sent.bytes,
                seconds: FLUSH_MS / 1000, moves: this.moves || 0, failedMoves: this.failedMoves || 0, deaths: this.deaths || 0,
                dead: this.players.filter(player => player.actor?.isDead()).length });
            sent = { packets, bytes };
            schedule = [];
            handler = [];
            errors = 0;
            this.moves = 0;
            this.failedMoves = 0;
            this.deaths = 0;
        }, FLUSH_MS).unref?.();
    }
};

module.exports = HotCrowd;
module.exports.crowdLocation = crowdLocation;
module.exports.crowdLocations = crowdLocations;
