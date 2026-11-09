const util = require('util');

// Override `require` for more convenient referrals. A loaded module is
// remembered by name: hot paths call invoke() per decision, and a plain
// require() resolves the path on disk each time. The remembered entry is
// reused only while it is still the one in require.cache (tests may delete
// or replace it to reload a module) and has finished loading (a circular
// require still sees the partial exports through require itself).
const invoked = new Map();
global.invoke = (module) => {
    const held = invoked.get(module);
    if (held && held.loaded && require.cache[held.id] === held) return held.exports;
    const file = require.resolve(__dirname + '/' + module);
    const exports = require(file);
    const entry = require.cache[file];
    if (entry?.loaded) invoked.set(module, entry);
    return exports;
};

// Town zones: the C4 town outlines (Lisvus townZones.xml, imported by
// scripts/generate-c4-town-zones.js), each with its bounding box. Every town
// is a peace zone but Floran Village, the PK town open to PvP (Lisvus; Mobius
// C4 makes Floran peace too). Heights are not checked: callers pass a map
// point, and no town lies over or under a hunting ground.
const TOWN_ZONES = require('../data/World/c4_town_zones.json').towns.map(({ name, peace, outline }) => ({
    name, peace: peace === true, outline,
    minX: Math.min(...outline.map(node => node.x)), maxX: Math.max(...outline.map(node => node.x)),
    minY: Math.min(...outline.map(node => node.y)), maxY: Math.max(...outline.map(node => node.y))
}));

// Inside an outline: a ray from the point crosses its edges an odd number of times.
function insideOutline(outline, x, y) {
    let inside = false;
    for (let at = 0, prev = outline.length - 1; at < outline.length; prev = at++) {
        const a = outline[at], b = outline[prev];
        if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

// The town zone holding a map point, or null in the field (towns never overlap).
function townZoneAt(locX, locY) {
    const x = Number(locX), y = Number(locY);
    for (let at = 0; at < TOWN_ZONES.length; at++) {
        const zone = TOWN_ZONES[at];
        if (x >= zone.minX && x <= zone.maxX && y >= zone.minY && y <= zone.maxY && insideOutline(zone.outline, x, y)) return zone;
    }
    return null;
}

global.utils = {
    infoSuccess(prefix, ...params) {
        console.info('\x1b[32m' + prefix.slice(0, 10) + ' '.repeat(10 - Math.min(prefix.length, 10)) + ' :: ' + util.format(...params) + '\x1b[0m');
    },

    infoWarn(prefix, ...params) {
        console.info('\x1b[33m' + prefix.slice(0, 10) + ' '.repeat(10 - Math.min(prefix.length, 10)) + ' :: ' + util.format(...params) + '\x1b[0m');
    },

    infoFail(prefix, ...params) {
        console.info('\x1b[31m' + prefix.slice(0, 10) + ' '.repeat(10 - Math.min(prefix.length, 10)) + ' :: ' + util.format(...params) + '\x1b[0m');
        process.exit();
    },

    currentDate() {
        return new Date().toISOString().slice(0, 10);
    },

    nodeVersion() {
        return process.versions.node;
    },

    buildNumber() {
        return require('../package').version;
    },

    fileExists(filename) {
        return require('fs').existsSync(filename);
    },

    parseRawFile(filename, charset = 'utf8') {
        return require('fs').readFileSync(filename, charset);
    },

    toHex(value, padding = 2) {
        return Number(value).toString(16).padStart(padding, '0');
    },

    randomNumber(max) {
        return Math.floor(Math.random() * max);
    },

    oneFromSpan(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    },

    tupleAlloc(count, data) {
        return new Array(count).fill(data);
    },

    stripNull(value) {
        // `String.prototype.toString` ignores its arguments, so decoding has to be
        // explicit or a raw byte string keeps its high bytes as latin-1 characters.
        const text = Buffer.isBuffer(value) ? value.toString('latin1') : String(value);
        return text.replace(/\u0000/g, '');
    },

    sqrt(value) {
        return Math.sqrt(value) || 0;
    },

    pad32Bits(data) {
        const size = data.length;
        const pad  = Buffer.alloc((Math.ceil(size / 4) * 4) - size);
        return Buffer.concat([data, pad]);
    },

    sessionMatch(pair1, pair2) {
        return (pair1.key1 === pair2.key1) && (pair1.key2 === pair2.key2);
    },

    fetchIPv4Address() {
        let network = require('os').networkInterfaces();
        let interface = network['Ethernet'].find((ob) => ob.family === 'IPv4');
        return interface.address ?? '0.0.0.0';
    },

    crushOb(ob) {
        return require('objcrush')(ob);
    },

    // No PvP here: a town zone other than Floran.
    isInPeaceZone(locX, locY) {
        return townZoneAt(locX, locY)?.peace === true;
    },

    // Inside a town's outline, Floran included: where a shop may open.
    isInTownZone(locX, locY) {
        return townZoneAt(locX, locY) !== null;
    },

    totalMemUsed() {
        if (!(invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true)) return;
        console.info('NodeL2     :: Total Mem Used -> %f MB', Math.round(process.memoryUsage().heapTotal / 1024 / 1024 * 100) / 100);
    },

    size(ob) {
        return ob.length;
    }
};

function mergeConfig(base, override) {
    Object.keys(override || {}).forEach((key) => {
        const baseValue = base[key];
        const overrideValue = override[key];

        if (
            baseValue &&
            overrideValue &&
            typeof baseValue === 'object' &&
            typeof overrideValue === 'object' &&
            !Array.isArray(baseValue) &&
            !Array.isArray(overrideValue)
        ) {
            mergeConfig(baseValue, overrideValue);
        } else {
            base[key] = overrideValue;
        }
    });

    return base;
}

const ini = require('js-ini');
const defaultConfig = ini.parse(utils.parseRawFile('./config/default.ini'));
const configOverridePath = process.env.L2NODE_CONFIG_FILE;
const sharedConfigPath = process.env.L2NODE_SHARED_CONFIG_FILE;
const localConfigPath = configOverridePath ? null : './config/local.ini';
const configLayers = [sharedConfigPath, localConfigPath, configOverridePath]
    .filter(Boolean)
    .map((configPath) => (utils.fileExists(configPath)
        ? ini.parse(utils.parseRawFile(configPath))
        : {}));

global.options = {
    default: configLayers.reduce((config, layer) => mergeConfig(config, layer), defaultConfig)
};

require(__dirname + '/GameServer/Progression/ProgressionCap').validate(global.options.default);

global.path = {
    world: 'GameServer/World/Generics/',
    actor: 'GameServer/Actor/Generics/',
    npc: 'GameServer/Npc/Generics'
}
