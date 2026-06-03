// Override `require` for more convenient referrals
global.invoke = (module) => {
    return require(__dirname + '/' + module);
};

global.utils = {
    infoSuccess(prefix, ...params) {
        console.info('\x1b[32m' + prefix.slice(0, 10) + ' '.repeat(10 - Math.min(prefix.length, 10)) + ' :: ' + require('util').format(...params) + '\x1b[0m');
    },

    infoWarn(prefix, ...params) {
        console.info('\x1b[33m' + prefix.slice(0, 10) + ' '.repeat(10 - Math.min(prefix.length, 10)) + ' :: ' + require('util').format(...params) + '\x1b[0m');
    },

    infoFail(prefix, ...params) {
        console.info('\x1b[31m' + prefix.slice(0, 10) + ' '.repeat(10 - Math.min(prefix.length, 10)) + ' :: ' + require('util').format(...params) + '\x1b[0m');
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
        return value.toString('ascii').replace(/\u0000/gi, '');
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

    isInPeaceZone(locX, locY) {
        const PEACE_ZONES = [
            { x: -84318, y: 244579, r: 8000 }, // TI
            { x: -12672, y: 122776, r: 6000 }, // Gludio
            { x: 15664,  y: 142979, r: 6000 }, // Dion
            { x: 83400,  y: 147943, r: 8000 }, // Giran
            { x: 82960,  y: 53177,  r: 6000 }  // Oren
        ];
        return PEACE_ZONES.some(zone => {
            const dx = zone.x - locX;
            const dy = zone.y - locY;
            return (dx * dx + dy * dy) <= (zone.r * zone.r);
        });
    },

    totalMemUsed() {
        console.info('NodeL2     :: Total Mem Used -> %f MB', Math.round(process.memoryUsage().heapTotal / 1024 / 1024 * 100) / 100);
    },

    size(ob) {
        return ob.length;
    }
};

global.options = {
    default: require('js-ini').parse(
        utils.parseRawFile('./config/default.ini')
    )
};

global.path = {
    world: 'GameServer/World/Generics/',
    actor: 'GameServer/Actor/Generics/',
    npc: 'GameServer/Npc/Generics'
}
