// PKs are encounter actors, not part of the background farming population.
// Each profile is anchored to a hunting ground and only becomes eligible while
// an appropriately levelled player or ordinary bot is using that ground.
const ENCOUNTERS = [
    {
        id: 'starter_wilds',
        name: 'Starter Fields',
        activationRadius: 4500,
        patrolRadius: 1100,
        targetMinLevel: 1,
        targetMaxLevel: 20
    },
    {
        id: 'dion_wasteland',
        name: 'Dion Wasteland',
        anchor: { locX: 74450, locY: 144238, locZ: -3730 },
        activationRadius: 7000,
        patrolRadius: 1800,
        targetMinLevel: 24,
        targetMaxLevel: 34
    },
    {
        id: 'gludio_ruins',
        name: 'Gludio Ruins',
        anchor: { locX: -17280, locY: 125392, locZ: -3120 },
        activationRadius: 7000,
        patrolRadius: 1800,
        targetMinLevel: 32,
        targetMaxLevel: 42
    },
    {
        id: 'oren_fields',
        name: 'Oren Fields',
        anchor: { locX: 76576, locY: 50151, locZ: -3200 },
        activationRadius: 8000,
        patrolRadius: 2200,
        targetMinLevel: 40,
        targetMaxLevel: 52
    }
];

const PK_BOTS = [
    {
        name: 'Nessa', username: 'bot_pk_nessa', race: 0, classId: 0, sex: 1,
        level: 12, karma: 240, pk: 1, encounterId: 'starter_wilds', dynamicStarter: true
    },
    {
        name: 'Brok', username: 'bot_pk_brok', race: 4, classId: 53, sex: 0,
        level: 16, karma: 360, pk: 1, encounterId: 'starter_wilds', dynamicStarter: true
    },
    {
        name: 'Dren', username: 'bot_pk_dren', race: 2, classId: 31, sex: 0,
        level: 19, karma: 480, pk: 2, encounterId: 'starter_wilds', dynamicStarter: true
    },
    {
        name: 'Ravok', username: 'bot_pk_ravok', race: 0, classId: 10, sex: 0,
        level: 30, karma: 720, pk: 2, encounterId: 'dion_wasteland'
    },
    {
        name: 'Vesha', username: 'bot_pk_vesha', race: 2, classId: 38, sex: 1,
        level: 38, karma: 960, pk: 3, encounterId: 'gludio_ruins'
    },
    {
        name: 'Kharz', username: 'bot_pk_kharz', race: 3, classId: 44, sex: 0,
        level: 46, karma: 1200, pk: 4, encounterId: 'oren_fields'
    },
    {
        name: 'Syris', username: 'bot_pk_syris', race: 1, classId: 18, sex: 1,
        level: 44, karma: 1200, pk: 4, encounterId: 'oren_fields'
    }
];

function encounterFor(id) {
    return ENCOUNTERS.find((encounter) => encounter.id === id) || null;
}

function profileFor(bot, anchor = null) {
    const encounter = encounterFor(bot?.encounterId);
    if (!encounter) return null;
    return {
        ...encounter,
        anchor: anchor || encounter.anchor,
        level: Number(bot.level || 1),
        encounterId: encounter.id
    };
}

function asBotData(bot, anchor = null) {
    const fallbackAnchor = anchor || encounterFor(bot?.encounterId)?.anchor || starterAnchorPool()[0];
    const profile = profileFor(bot, fallbackAnchor);
    if (!profile) return null;
    return {
        ...bot,
        plan: 'pk_hunting',
        fullNewbieBlessing: false,
        locX: profile.anchor.locX,
        locY: profile.anchor.locY,
        locZ: profile.anchor.locZ,
        homeRegion: profile.name,
        visitor: true,
        pkProfile: profile
    };
}

function starterAnchorPool() {
    const DataCache = invoke('GameServer/DataCache');
    const fallbacks = [
        { locX: -72662, locY: 258431, locZ: -3104 },
        { locX: 43648, locY: 40352, locZ: -3440 },
        { locX: 26716, locY: 11680, locZ: -4224 },
        { locX: -56936, locY: -112448, locZ: -679 },
        { locX: 107520, locY: -175808, locZ: -400 }
    ];
    const spawns = (DataCache.newbieSpawns || []).flatMap((entry) => entry.spawns || []);
    return spawns.length > 0 ? spawns : fallbacks;
}

function shuffled(items, random = Math.random) {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index--) {
        const swap = Math.floor(random() * (index + 1));
        [copy[index], copy[swap]] = [copy[swap], copy[index]];
    }
    return copy;
}

function materializeBots(random = Math.random) {
    const anchors = shuffled(starterAnchorPool(), random);
    let anchorIndex = 0;
    return PK_BOTS.map((bot) => {
        const anchor = bot.dynamicStarter ? anchors[anchorIndex++ % anchors.length] : null;
        return asBotData(bot, anchor);
    });
}

module.exports = {
    ENCOUNTERS,
    PK_BOTS,
    encounterFor,
    profileFor,
    asBotData,
    materializeBots
};
