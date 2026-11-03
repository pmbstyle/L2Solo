'use strict';

const { performance } = require('perf_hooks');

// The hot scenario of a window run (scripts/perf/window.js sets L2NODE_PERF_SCENARIO=hot): players
// stand where the most cold bots hunt, and the population's own activation heats the crowd around
// them (activateNearPlayers counts these sessions as real players: not a BotSession, account not
// bot_*). The bots become hot by the path a real player causes; nothing here ticks them.
// - L2NODE_PERF_PLAYERS: players, each at another of the fullest places (two activation radii
//   apart, so their crowds do not merge);
// - L2NODE_PERF_ROUTE: places on a route; every L2NODE_PERF_ROUTE_MINUTES each player teleports
//   (the gatekeeper's teleport) to the next one, so crowds cool behind them and heat ahead: the
//   cold <-> hot transitions a moving player causes, all through the window;
// - a probe on the first player: every 50 ms their position packet goes through ValidatePosition,
//   timing how late the timer fired (the event loop the packet waited for) and the handler.
// A player is the server's own Session on a socket that only counts what is written to it, so every
// per-player cost of the real path runs: packing, character / NPC / ground-item visibility, the bots'
// broadcasts written to the player's socket. Every 30 s a "player" line goes to the live recorder's
// timeline: probe samples, packets and bytes written to the players' sockets, moves, hot bots.

const ACCOUNT = 'perf_player';
const PROBE_MS = 50;
const FLUSH_MS = 30000;
// Bots are grouped in cells this wide to find the crowds.
const CELL = 3000;

const envNumber = (name, fallback, min, max) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
};

// The client end of a player: takes the packed packets the server writes and counts them.
function countingSocket() {
    return { packets: 0, bytes: 0, remoteAddress: '127.0.0.1',
        write(buffer) { this.packets += 1; this.bytes += buffer?.length || 0; return true; },
        on() { return this; }, once() { return this; }, end() {}, destroy() {}, setNoDelay() {} };
}

function positionPacket(actor, sequence) {
    const packet = Buffer.alloc(21);
    packet.writeInt32LE(Number(actor.fetchLocX?.() || 0), 1);
    packet.writeInt32LE(Number(actor.fetchLocY?.() || 0), 5);
    packet.writeInt32LE(Number(actor.fetchLocZ?.() || 0), 9);
    packet.writeInt32LE((Number(actor.fetchHead?.() || 0) + sequence) & 0xffff, 13);
    return packet;
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

    start() {
        if (process.env.L2NODE_PERF_SCENARIO !== 'hot' || this.started) return;
        this.started = true;
        this.count = envNumber('L2NODE_PERF_PLAYERS', 1, 1, 20);
        this.routeStops = envNumber('L2NODE_PERF_ROUTE', 0, 0, 50);
        this.routeMs = envNumber('L2NODE_PERF_ROUTE_MINUTES', 3, 1, 120) * 60000;
        const timer = setInterval(() => {
            const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
            if (!Coordinator.ready || !Coordinator.snapshotsLoaded) return;
            clearInterval(timer);
            this.place();
        }, 1000);
    },

    place() {
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const Config = invoke('GameServer/Bot/Population/PopulationConfig');
        const BotManager = invoke('GameServer/Bot/BotManager');
        this.stops = crowdLocations(LifeState.allStates(100000), Math.max(this.count, this.routeStops),
            2 * Number(Config.activationRadius || 9000));
        if (!this.stops.length) {
            utils.infoWarn('Perf', 'hot scenario: no cold hunting bot to stand by');
            return;
        }
        utils.infoSuccess('Perf', 'hot scenario: %d player(s), %d place(s)%s: %s', this.count, this.stops.length,
            this.routeStops ? `, moving every ${this.routeMs / 60000} min` : '',
            this.stops.map(stop => `${stop.locX},${stop.locY} (${stop.bots} cold hunters)`).join('; '));
        this.step = 0;
        for (let index = 0; index < this.count; index++) {
            const stop = this.stops[index % this.stops.length];
            const account = `${ACCOUNT}${index + 1}`;
            BotManager.provisionAndSpawn({ username: account, name: `PerfPlayer${index + 1}`, race: 0, sex: 0, classId: 0,
                face: 0, hair: 0, hairColor: 0, plan: 'hunting', fullNewbieBlessing: false,
                locX: stop.locX, locY: stop.locY, locZ: stop.locZ }, index);
        }
        const wait = setInterval(() => {
            const sources = BotManager.sessions.filter(session => session?.actor && String(session.accountId).startsWith(ACCOUNT));
            if (sources.length < this.count) return;
            clearInterval(wait);
            sources.sort((a, b) => a.accountId.localeCompare(b.accountId, 'en', { numeric: true })).forEach(source => this.attach(source));
            this.probe();
            if (this.routeStops > 1) setInterval(() => this.move(), this.routeMs).unref?.();
        }, 500);
    },

    // A spawned character leaves the bot sessions (no AI of its own) and enters the world as a user,
    // set up as Session.setActor sets a logged-in one (the actor is the spawned one).
    attach(source) {
        const BotManager = invoke('GameServer/Bot/BotManager');
        const Session = invoke('GameServer/Session');
        source.aiActive = false;
        if (source.aiTimeout) clearTimeout(source.aiTimeout);
        source.aiTimeout = null;
        invoke('GameServer/Bot/AI/HotAiDispatcher').cancel(source);
        BotManager.sessions = BotManager.sessions.filter(session => session !== source);
        const player = new Session(countingSocket());
        player.accountId = source.accountId;
        player.actor = source.actor;
        player.questStates = new Map();
        player.questStatesLoaded = false;
        player.activeNpcTalk = null;
        invoke('GameServer/World/Generics/NativeUiSession').reset(player);
        source.actor.session = player;
        invoke('GameServer/World/World').insertUser(player);
        this.players.push(player);
    },

    move() {
        this.step += 1;
        this.moves = (this.moves || 0) + this.players.length;
        this.players.forEach((player, index) => {
            const stop = this.stops[(index + this.step) % this.stops.length];
            invoke(path.actor).teleportTo(player, player.actor, { locX: stop.locX, locY: stop.locY, locZ: stop.locZ, head: 0 });
        });
    },

    probe() {
        const ValidatePosition = invoke('GameServer/Network/Request/ValidatePosition');
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const Recorder = invoke('Perf/LiveRecorder');
        const first = this.players[0];
        const round = (ms) => Math.round(ms * 10) / 10;
        let schedule = [], handler = [], errors = 0, sequence = 0, expected = performance.now() + PROBE_MS;
        let sent = { packets: 0, bytes: 0 };
        setInterval(() => {
            const now = performance.now();
            schedule.push(round(Math.max(0, now - expected)));
            expected = now + PROBE_MS;
            const began = performance.now();
            try {
                ValidatePosition(first, positionPacket(first.actor, sequence++));
            } catch {
                errors += 1;
            }
            handler.push(round(performance.now() - began));
        }, PROBE_MS).unref?.();
        setInterval(() => {
            const packets = this.players.reduce((sum, player) => sum + player.socket.packets, 0);
            const bytes = this.players.reduce((sum, player) => sum + player.socket.bytes, 0);
            Recorder.note('player', { scheduleMs: schedule, handlerMs: handler, errors, hot: LifeState.counts().hot,
                players: this.players.length, packets: packets - sent.packets, bytes: bytes - sent.bytes,
                seconds: FLUSH_MS / 1000, moves: this.moves || 0 });
            sent = { packets, bytes };
            schedule = [];
            handler = [];
            errors = 0;
            this.moves = 0;
        }, FLUSH_MS).unref?.();
    }
};

module.exports = HotCrowd;
module.exports.crowdLocation = crowdLocation;
module.exports.crowdLocations = crowdLocations;
