// Chronicle 4 Gatekeeper Ziggurat pairs from L2J Lisvus spawnlist.sql and
// teleport.sql. Seven Signs is not implemented yet, so the source server's
// SevenSignsDungeonNPCAccess override is represented by always exposing these
// entry and exit links.
const DUNGEONS = [
    {
        name: 'Necropolis of Sacrifice',
        outside: { npcId: 8095, spawn: [-41564, 209356, -5088, 8192], destination: [-41570, 209785, -5089] },
        inside: { npcId: 8103, spawn: [-41571, 210126, -5080, 18318], destination: [-41567, 209292, -5091] }
    },
    {
        name: 'Necropolis of Pilgrims',
        outside: { npcId: 8096, spawn: [45248, 124352, -5408, 16500], destination: [45251, 123890, -5415] },
        inside: { npcId: 8104, spawn: [45280, 123504, -5408, 49000], destination: [45250, 124366, -5417] }
    },
    {
        name: 'Necropolis of Worshipers',
        outside: { npcId: 8097, spawn: [110848, 174016, -5432, 16384], destination: [111273, 174015, -5417] },
        inside: { npcId: 8105, spawn: [111600, 174016, -5432, 16500], destination: [110818, 174010, -5443] }
    },
    {
        name: 'Necropolis of Patriots',
        outside: { npcId: 8098, spawn: [-22224, 77376, -5168, 32500], destination: [-21726, 77385, -5177] },
        inside: { npcId: 8106, spawn: [-21392, 77376, -5168, 16500], destination: [-22197, 77369, -5177] }
    },
    {
        name: 'Necropolis of Ascetics',
        outside: { npcId: 8099, spawn: [-52784, 79104, -4736, 33000], destination: [-52254, 79103, -4743] },
        inside: { npcId: 8107, spawn: [-51920, 79104, -4736, 0], destination: [-52716, 79106, -4745] }
    },
    {
        name: 'Necropolis of Martyrs',
        outside: { npcId: 8100, spawn: [117872, 132800, -4824, 32500], destination: [118308, 132800, -4833] },
        inside: { npcId: 8108, spawn: [118640, 132800, -4824, 16500], destination: [117793, 132810, -4835] }
    },
    {
        name: 'Necropolis of Saints',
        outside: { npcId: 8101, spawn: [82688, 209216, -5432, 32500], destination: [83000, 209213, -5443] },
        inside: { npcId: 8109, spawn: [83440, 209216, -5432, 16500], destination: [82608, 209225, -5443] }
    },
    {
        name: 'Necropolis of the Disciples',
        outside: { npcId: 8102, spawn: [171936, -17600, -4896, 48457], destination: [172251, -17605, -4903] },
        inside: { npcId: 8110, spawn: [172649, -17599, -4896, 32768], destination: [171902, -17595, -4905] }
    },
    {
        name: 'Catacomb of the Heretics',
        outside: { npcId: 8114, spawn: [42590, 143933, -5376, 16384], destination: [43050, 143933, -5383] },
        inside: { npcId: 8120, spawn: [43375, 143937, -5376, 16384], destination: [42514, 143917, -5385] }
    },
    {
        name: 'Catacomb of the Branded',
        outside: { npcId: 8115, spawn: [45800, 170296, -4976, 0], destination: [46217, 170290, -4983] },
        inside: { npcId: 8121, spawn: [46578, 170304, -4976, 134], destination: [45770, 170299, -4985] }
    },
    {
        name: 'Catacomb of the Apostate',
        outside: { npcId: 8116, spawn: [77250, 78388, -5120, 60891], destination: [78042, 78404, -5128] },
        inside: { npcId: 8122, spawn: [78055, 78405, -5120, 30488], destination: [77225, 78362, -5119] }
    },
    {
        name: 'Catacomb of the Witch',
        outside: { npcId: 8117, spawn: [140052, 79682, -5424, 16384], destination: [140404, 79678, -5431] },
        inside: { npcId: 8123, spawn: [140771, 79682, -5424, 16384], destination: [139965, 79678, -5433] }
    },
    {
        name: 'Catacomb of Dark Omens',
        outside: { npcId: 8118, spawn: [-19847, 13500, -4896, 624], destination: [-19500, 13508, -4905] },
        inside: { npcId: 8124, spawn: [-19085, 13504, -4896, 64238], destination: [-19931, 13502, -4905] }
    },
    {
        name: 'Catacomb of the Forbidden Path',
        outside: { npcId: 8119, spawn: [113505, 84534, -6536, 64055], destination: [113865, 84543, -6545] },
        inside: { npcId: 8125, spawn: [114286, 84543, -6536, 946], destination: [113429, 84540, -6545] }
    }
];

function zigguratNpc(selfId) {
    return {
        selfId,
        template: { kind: 'Teleporter', name: 'Gatekeeper Ziggurat', title: '', level: 70, hostile: false },
        base: { str: 40, dex: 30, con: 43, int: 21, wit: 20, men: 10 },
        stats: { pAtk: 1314, pAtkRnd: 30, pDef: 470, mAtk: 780, mDef: 382, accur: 4.75, atkSpd: 278, castSpd: 253, atkRadius: 40 },
        speed: { walk: 55, run: 132 },
        vitals: { maxHp: 3862, maxMp: 1493, revHp: 11.85, revMp: 2.78, corpseTime: 7000 },
        collision: { radius: 7, size: 15 },
        equipment: { weapon: 0, shield: 0, reuseTime: 0 },
        clan: { clanName: '', helpRadius: 0 },
        rewards: { exp: 0, sp: 0 }
    };
}

function coords(values) {
    const [locX, locY, locZ, head] = values;
    return { locX, locY, locZ, head };
}

const pairsByNpcId = new Map();
for (const dungeon of DUNGEONS) {
    pairsByNpcId.set(dungeon.outside.npcId, { dungeon, side: 'outside', endpoint: dungeon.outside });
    pairsByNpcId.set(dungeon.inside.npcId, { dungeon, side: 'inside', endpoint: dungeon.inside });
}

const npcs = [...pairsByNpcId.keys()].map(zigguratNpc);
const spawns = [{
    selfId: 'c4-seven-signs-gatekeeper-ziggurats',
    bounds: [],
    spawns: [...pairsByNpcId.values()].map(({ endpoint }) => ({
        selfId: endpoint.npcId,
        name: 'Gatekeeper Ziggurat',
        coords: [coords(endpoint.spawn)],
        total: 1,
        respawn: 15,
        bias: 0
    }))
}];

function destination(npcId) {
    const endpoint = pairsByNpcId.get(Number(npcId))?.endpoint;
    if (!endpoint) return null;
    const [locX, locY, locZ] = endpoint.destination;
    return { locX, locY, locZ };
}

function html(npcId) {
    const pair = pairsByNpcId.get(Number(npcId));
    if (!pair) return null;
    const action = pair.side === 'outside' ? 'Enter the Forbidden Sanctum' : 'Leave the Forbidden Sanctum';
    return [
        '<html><body>Gatekeeper Ziggurat:<br>',
        'Behold, the sphere speaks...<br>',
        `This portal leads ${pair.side === 'outside' ? 'into' : 'out of'} ${pair.dungeon.name}.<br><br>`,
        `<a action="bypass -h seven-signs-dungeon-teleport">${action}</a>`,
        '</body></html>'
    ].join('');
}

module.exports = { DUNGEONS, destination, html, npcs, spawns };
