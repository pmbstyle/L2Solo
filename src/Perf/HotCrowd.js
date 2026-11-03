'use strict';

const { performance } = require('perf_hooks');

// The hot scenario of a window run (scripts/perf/window.js sets L2NODE_PERF_SCENARIO=hot): one player
// stands where the most cold bots hunt, and the population's own activation heats the crowd around
// them (activateNearPlayers counts this session as a real player: not a BotSession, account not
// bot_*). The bots become hot by the path a real player causes; nothing here ticks them. A probe
// measures what that player feels: every 50 ms their position packet goes through ValidatePosition,
// timing how late the timer fired (the event loop the packet waited for) and how long the handler
// ran. Samples go to the live recorder's timeline as "player" lines every 30 s.

const ACCOUNT = 'perf_player';
const PROBE_MS = 50;
const FLUSH_MS = 30000;
// Bots are grouped in cells this wide to find the crowd (activationRadius is 9000 by default).
const CELL = 3000;

class PlayerSession {
    constructor(actor) {
        this.accountId = ACCOUNT;
        this.actor = actor;
        this.packets = 0;
    }

    fetchAccountId() { return this.accountId; }
    dataSendToMe() { this.packets += 1; }
    dataSendToOthers() { this.packets += 1; }
    dataSendToMeAndOthers() { this.packets += 1; }
}

function positionPacket(actor, sequence) {
    const packet = Buffer.alloc(21);
    packet.writeInt32LE(Number(actor.fetchLocX?.() || 0), 1);
    packet.writeInt32LE(Number(actor.fetchLocY?.() || 0), 5);
    packet.writeInt32LE(Number(actor.fetchLocZ?.() || 0), 9);
    packet.writeInt32LE((Number(actor.fetchHead?.() || 0) + sequence) & 0xffff, 13);
    return packet;
}

// Where the most cold hunting bots are: a bot's own location in the fullest cell (a point on
// walkable ground).
function crowdLocation(states) {
    const cells = new Map();
    for (const state of states) {
        const loc = state.loc;
        if (state.phase !== 'cold' || state.activity !== 'hunting' || !Number.isFinite(Number(loc?.locX))) continue;
        const key = `${Math.floor(loc.locX / CELL)}:${Math.floor(loc.locY / CELL)}`;
        const cell = cells.get(key) || { count: 0, loc };
        cell.count += 1;
        cells.set(key, cell);
    }
    const best = [...cells.values()].sort((a, b) => b.count - a.count)[0];
    return best ? { ...best.loc, bots: best.count } : null;
}

const HotCrowd = {
    started: false,
    session: null,

    start() {
        if (process.env.L2NODE_PERF_SCENARIO !== 'hot' || this.started) return;
        this.started = true;
        const timer = setInterval(() => {
            const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
            if (!Coordinator.ready || !Coordinator.snapshotsLoaded) return;
            clearInterval(timer);
            this.place();
        }, 1000);
    },

    place() {
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const BotManager = invoke('GameServer/Bot/BotManager');
        const loc = crowdLocation(LifeState.allStates(100000));
        if (!loc) {
            utils.infoWarn('Perf', 'hot scenario: no cold hunting bot to stand by');
            return;
        }
        utils.infoSuccess('Perf', 'hot scenario: player at %d,%d,%d among %d cold hunters', loc.locX, loc.locY, loc.locZ, loc.bots);
        BotManager.provisionAndSpawn({ username: ACCOUNT, name: 'PerfPlayer', race: 0, sex: 0, classId: 0, face: 0,
            hair: 0, hairColor: 0, plan: 'hunting', fullNewbieBlessing: false,
            locX: loc.locX, locY: loc.locY, locZ: loc.locZ }, 0);
        const wait = setInterval(() => {
            const source = BotManager.sessions.find(session => session?.actor && session.accountId === ACCOUNT);
            if (!source) return;
            clearInterval(wait);
            this.attach(source);
        }, 500);
    },

    // The spawned character leaves the bot sessions (no AI of its own) and enters the world as a user.
    attach(source) {
        const BotManager = invoke('GameServer/Bot/BotManager');
        source.aiActive = false;
        if (source.aiTimeout) clearTimeout(source.aiTimeout);
        source.aiTimeout = null;
        invoke('GameServer/Bot/AI/HotAiDispatcher').cancel(source);
        BotManager.sessions = BotManager.sessions.filter(session => session !== source);
        this.session = new PlayerSession(source.actor);
        source.actor.session = this.session;
        invoke('GameServer/World/World').insertUser(this.session);
        this.probe();
    },

    probe() {
        const ValidatePosition = invoke('GameServer/Network/Request/ValidatePosition');
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const Recorder = invoke('Perf/LiveRecorder');
        const round = (ms) => Math.round(ms * 10) / 10;
        let schedule = [], handler = [], errors = 0, sequence = 0, expected = performance.now() + PROBE_MS;
        setInterval(() => {
            const now = performance.now();
            schedule.push(round(Math.max(0, now - expected)));
            expected = now + PROBE_MS;
            const began = performance.now();
            try {
                ValidatePosition(this.session, positionPacket(this.session.actor, sequence++));
            } catch {
                errors += 1;
            }
            handler.push(round(performance.now() - began));
        }, PROBE_MS).unref?.();
        setInterval(() => {
            Recorder.note('player', { scheduleMs: schedule, handlerMs: handler, errors, hot: LifeState.counts().hot,
                packets: this.session.packets });
            schedule = [];
            handler = [];
            errors = 0;
        }, FLUSH_MS).unref?.();
    }
};

module.exports = HotCrowd;
module.exports.crowdLocation = crowdLocation;
