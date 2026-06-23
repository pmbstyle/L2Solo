const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8'
};

const WORLD_BOUNDS = {
    minX: -131072,
    maxX: 229376,
    minY: -262144,
    maxY: 262144
};

const MAP_TILES = {
    source: 'https://github.com/npetrovski/l2-world-map',
    rawBaseUrl: 'https://raw.githubusercontent.com/npetrovski/l2-world-map/main/Maps',
    blockSize: 32768,
    blockPx: 900,
    x: { min: 16, max: 26, mid: 20 },
    y: { min: 10, max: 25, mid: 18 },
    hiddenRanges: [
        { x1: 16, x2: 16, y1: 11, y2: 13 },
        { x1: 17, x2: 22, y1: 10, y2: 13 },
        { x1: 26, x2: 26, y1: 10, y2: 25 }
    ],
    alternatives: [
        {
            name: 'L2J Aden',
            url: 'https://l2j.ru/freya/img/maps/c2_aden.jpg',
            note: 'clean poster map; needs manual coordinate calibration'
        },
        {
            name: 'L2J Elmore',
            url: 'https://l2j.ru/freya/img/maps/c2_elmore.jpg',
            note: 'clean poster map; separate northern continent image'
        }
    ]
};

const REGION_LABELS = [
    { name: 'Talking Island', locX: -84318, locY: 244579, kind: 'town' },
    { name: 'Gludin', locX: -80826, locY: 149775, kind: 'town' },
    { name: 'Gludio', locX: -12672, locY: 122776, kind: 'town' },
    { name: 'Dion', locX: 15664, locY: 142979, kind: 'town' },
    { name: 'Giran', locX: 83400, locY: 147943, kind: 'town' },
    { name: 'Oren', locX: 82960, locY: 53177, kind: 'town' },
    { name: 'Heine', locX: 111395, locY: 219000, kind: 'town' },
    { name: 'Elven Village', locX: 46934, locY: 51467, kind: 'starter' },
    { name: 'Dark Elven Village', locX: 9745, locY: 15606, kind: 'starter' },
    { name: 'Orc Village', locX: -44133, locY: -113911, kind: 'starter' },
    { name: 'Dwarven Village', locX: 115120, locY: -178212, kind: 'starter' }
];

function isEnabled() {
    const config = options.default.WorldObserver || {};
    return config.enabled !== false && String(config.enabled || 'true').toLowerCase() !== 'false';
}

function safePercent(value) {
    const number = Number(value || 0);
    return Math.max(0, Math.min(100, Math.round(number * 100)));
}

function actorLoc(actor) {
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
}

function actorVitals(actor) {
    return {
        hp: actor.fetchHp(),
        maxHp: actor.fetchMaxHp(),
        hpPct: safePercent(actor.fetchHp() / Math.max(1, actor.fetchMaxHp())),
        mp: actor.fetchMp(),
        maxMp: actor.fetchMaxMp(),
        mpPct: safePercent(actor.fetchMp() / Math.max(1, actor.fetchMaxMp()))
    };
}

function realPlayerSessions() {
    const World = invoke('GameServer/World/World');
    return (World.user?.sessions || []).filter((session) => (
        session.actor &&
        session.accountId &&
        !String(session.accountId).startsWith('bot_')
    ));
}

function compactPlayer(session) {
    const actor = session.actor;
    return {
        id: actor.fetchId(),
        name: actor.fetchName(),
        level: actor.fetchLevel(),
        loc: actorLoc(actor),
        vitals: actorVitals(actor),
        online: !!actor.fetchIsOnline()
    };
}

function compactHotBot(status) {
    return {
        id: status.id,
        name: status.name,
        phase: 'hot',
        level: status.level,
        classId: status.classId,
        mode: status.mode,
        intent: status.intent,
        role: status.role,
        home: status.home,
        loc: status.loc,
        vitals: {
            hpPct: safePercent(status.vitals?.hpPct),
            mpPct: safePercent(status.vitals?.mpPct)
        },
        target: status.target ? {
            type: status.target.type,
            name: status.target.name || null,
            distance: status.target.distance ? Math.round(status.target.distance) : null
        } : null,
        party: status.party ? {
            leader: status.party.leader?.name || null,
            stance: status.party.stance,
            role: status.party.role
        } : null,
        spot: status.spot ? {
            id: status.spot.id,
            name: status.spot.name,
            minLevel: status.spot.minLevel,
            maxLevel: status.spot.maxLevel,
            density: status.spot.density
        } : null,
        movement: status.movement,
        nearby: status.nearby,
        trade: status.trade,
        blockers: status.blockers || [],
        lastSocialEvent: status.lastSocialEvent || null,
        roleDecision: status.roleDecision || null
    };
}

function compactStateBot(state, hotIds) {
    if (hotIds.has(Number(state.characterId))) return null;
    return {
        id: Number(state.characterId),
        name: state.name || 'Bot',
        phase: state.phase || 'cold',
        level: Number(state.level || 1),
        mode: state.activity || 'hunting',
        intent: state.phase === 'warm' ? 'background_active' : 'background_resolve',
        role: state.party?.role || state.stats?.role || 'dps',
        home: {
            region: state.homeRegion || state.currentRegion || null,
            visitor: false
        },
        loc: state.loc || { locX: 0, locY: 0, locZ: 0 },
        vitals: {
            hpPct: safePercent(Number(state.vitals?.hp || 0) / Math.max(1, Number(state.vitals?.maxHp || 1))),
            mpPct: safePercent(Number(state.vitals?.mp || 0) / Math.max(1, Number(state.vitals?.maxMp || 1)))
        },
        target: null,
        party: state.party?.partyId ? {
            id: state.party.partyId,
            role: state.party.role || state.stats?.role || 'dps',
            leaderId: state.party.leaderId || null
        } : null,
        spot: state.spotId ? { id: state.spotId, name: state.spotId } : null,
        movement: { moving: false, towards: false, stuckTicks: 0 },
        nearby: null,
        trade: null,
        blockers: [],
        updatedAt: state.updatedAt || 0
    };
}

function countBy(items, field) {
    return items.reduce((counts, item) => {
        const value = item[field] || 'unknown';
        counts[value] = (counts[value] || 0) + 1;
        return counts;
    }, {});
}

function buildSyntheticEvents(bots) {
    return bots
        .filter((bot) => bot.phase === 'hot')
        .slice(0, 8)
        .map((bot) => {
            const detail = bot.target?.name ? `targeting ${bot.target.name}` :
                bot.spot?.name ? `near ${bot.spot.name}` :
                bot.party?.leader ? `following ${bot.party.leader}` :
                bot.intent;
            return {
                type: bot.mode || 'bot',
                summary: `${bot.name} is ${detail}`,
                createdAt: Date.now(),
                weight: 1
            };
        });
}

function snapshot() {
    const BotManager = invoke('GameServer/Bot/BotManager');
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
    const PopulationStatus = invoke('GameServer/Bot/Population/PopulationStatus');

    const hotBots = BotManager.getAllBotStatuses()
        .filter((status) => status && status.available)
        .map(compactHotBot);
    const hotIds = new Set(hotBots.map((bot) => Number(bot.id)));
    const stateBots = LifeState.allStates(700)
        .map((state) => compactStateBot(state, hotIds))
        .filter(Boolean);
    const bots = [...hotBots, ...stateBots];
    const players = realPlayerSessions().map(compactPlayer);
    const memory = process.memoryUsage();

    return LifeEvents.recent(18).then((events) => ({
        generatedAt: Date.now(),
        uptimeMs: Math.round(process.uptime() * 1000),
        bounds: WORLD_BOUNDS,
        mapTiles: MAP_TILES,
        labels: REGION_LABELS,
        population: PopulationStatus.counts(),
        runtime: {
            heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
            rssMb: Math.round(memory.rss / 1024 / 1024)
        },
        players,
        bots,
        stats: {
            botsByPhase: countBy(bots, 'phase'),
            botsByMode: countBy(bots, 'mode'),
            botsByRole: countBy(bots, 'role'),
            activeTargets: hotBots.filter((bot) => bot.target).length,
            moving: hotBots.filter((bot) => bot.movement?.moving).length,
            blockers: hotBots.filter((bot) => bot.blockers?.length).length
        },
        events: events.length > 0 ? events : buildSyntheticEvents(bots)
    }));
}

function sendJson(response, data, statusCode = 200) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify(data));
}

function sendFile(response, filePath) {
    fs.readFile(filePath, (err, body) => {
        if (err) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }

        response.writeHead(200, {
            'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
        });
        response.end(body);
    });
}

function route(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/observer') {
        response.writeHead(302, { Location: '/observer/' });
        response.end();
        return;
    }

    if (url.pathname === '/observer/api/snapshot') {
        snapshot()
            .then((data) => sendJson(response, data))
            .catch((err) => sendJson(response, { error: err.message }, 500));
        return;
    }

    if (url.pathname.startsWith('/observer/')) {
        const relative = url.pathname.replace(/^\/observer\/?/, '') || 'index.html';
        const safeRelative = path.normalize(relative).replace(/^(\.\.[/\\])+/, '');
        const filePath = path.join(PUBLIC_DIR, safeRelative);
        if (!filePath.startsWith(PUBLIC_DIR)) {
            response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Forbidden');
            return;
        }
        sendFile(response, filePath);
        return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
}

const WorldObserverServer = {
    server: null,

    init() {
        if (!isEnabled() || this.server) return;

        const config = options.default.WorldObserver || {};
        const hostname = config.hostname || '127.0.0.1';
        const port = Number(config.port || 8088);

        this.server = http.createServer(route);
        this.server.listen(port, hostname, () => {
            utils.infoSuccess('Observer', 'world observer ready at http://%s:%d/observer/', hostname, port);
        });

        this.server.on('error', (err) => {
            utils.infoWarn('Observer', 'world observer failed: %s', err.message);
        });
    }
};

module.exports = WorldObserverServer;
