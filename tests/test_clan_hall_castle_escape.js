const assert = require('assert');

require('../src/Global');

// V13 (user, 2026-10-05): a Scroll of Escape to a clan hall or a castle always
// moves its user, as in C4 (MapRegionTable.getTeleToLocation): to the clan's own
// hall when it owns one, otherwise to the town by the region rule (the PK point
// with karma); the scroll is consumed. This server has no castle owners, so a
// castle scroll always goes to town. The author's real item path is used:
// Backpack.useSkillItem -> applySelfItemSkill -> C4SkillEffects recall.
const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const TownRespawn = invoke('GameServer/World/TownRespawn');
const Backpack = invoke('GameServer/Actor/Backpack');
const C4ItemSkills = invoke('GameServer/Items/C4ItemSkills');
const HallRuntime = require('../src/GameServer/ClanHall/Runtime');

let captured = null;
const realInvoke = global.invoke;
global.invoke = (module) => {
    if (module === 'GameServer/Actor/Generics/TeleportTo') {
        return (_session, _actor, coords) => { captured = coords; };
    }
    return realInvoke(module);
};

const ServerResponse = realInvoke('GameServer/Network/Response');
const realResponses = {};
for (const name of Object.keys(ServerResponse)) {
    if (typeof ServerResponse[name] !== 'function') continue;
    realResponses[name] = ServerResponse[name];
    ServerResponse[name] = () => ({ tag: name });
}

const HALL = HallRuntime.Policy.catalog.halls[0];
const OWNER_CLAN = 77;
// Dion fields: the town restart is Dion's gatekeeper, the PK point is Floran's.
const PLACE = { locX: 22000, locY: 140000, locZ: -3000 };

function actorAt(karma, clanId) {
    let casts = false;
    const actor = {
        fetchId: () => 2999013, fetchName: () => 'V13', fetchLocX: () => PLACE.locX, fetchLocY: () => PLACE.locY,
        fetchLocZ: () => PLACE.locZ, fetchKarma: () => karma, fetchPk: () => 0, fetchPrivateStoreType: () => 0,
        fetchClanId: () => clanId, fetchClassId: () => 0, fetchLevel: () => 40,
        isDead: () => false, isInOlympiadMode: () => false,
        markSkillReuse() {},
        state: { fetchCasts: () => casts, setCasts(value) { casts = value; }, fetchDead: () => false }
    };
    const session = { actor, dataSendToMe() {}, dataSendToMeAndOthers() {} };
    actor.session = session;
    return { actor, session };
}

function useScroll(itemId, karma, clanId) {
    captured = null;
    const { actor, session } = actorAt(karma, clanId);
    const backpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    let consumed = 0;
    backpack.deleteItem = (_session, _id, amount, callback) => { consumed += amount; callback(); };
    const realTimeout = global.setTimeout;
    global.setTimeout = (callback) => { callback(); return 0; };
    try {
        backpack.useSkillItem(session, 1, C4ItemSkills.resolve(itemId));
    } finally {
        global.setTimeout = realTimeout;
    }
    return { coords: captured, consumed, actor };
}

function isPkPoint(coords) {
    return Object.values(TownRespawn.CHAOTIC_RESPAWNS)
        .some((points) => points.some(([x, y, z]) => x === coords.locX && y === coords.locY && z === coords.locZ));
}

try {
    HallRuntime.applyRows([{ id: HALL.id, ownerId: OWNER_CLAN, functionsJson: '{}' }]);
    const dionGatekeeper = TownRespawn.getRespawnCoords(PLACE.locX, PLACE.locY, PLACE.locZ);

    for (const itemId of [1829, 5858]) {
        const owned = useScroll(itemId, 0, OWNER_CLAN);
        assert.deepStrictEqual(owned.coords, HALL.spawn, `${itemId}: a hall owner lands in the own hall`);
        assert.strictEqual(owned.consumed, 1, `${itemId}: the scroll is consumed`);

        const noHall = useScroll(itemId, 0, 78);
        assert.deepStrictEqual(noHall.coords, dionGatekeeper, `${itemId}: without an owned hall the scroll goes to the town gatekeeper`);
        assert.strictEqual(noHall.consumed, 1, `${itemId}: the scroll is consumed without a hall too`);

        const karma = useScroll(itemId, 500, 78);
        assert.ok(karma.coords && isPkPoint(karma.coords), `${itemId}: with karma and no hall the scroll goes to the region's PK point`);
        assert.strictEqual(karma.consumed, 1, `${itemId}: the scroll is consumed with karma`);
    }

    for (const itemId of [1830, 5859]) {
        const castle = useScroll(itemId, 0, OWNER_CLAN);
        assert.deepStrictEqual(castle.coords, dionGatekeeper, `${itemId}: no clan owns a castle, so the castle scroll goes to town`);
        assert.strictEqual(castle.consumed, 1, `${itemId}: the castle scroll is consumed`);

        const karma = useScroll(itemId, 500, 0);
        assert.ok(karma.coords && isPkPoint(karma.coords), `${itemId}: with karma the castle scroll goes to the PK point`);
        assert.strictEqual(karma.consumed, 1, `${itemId}: the castle scroll is consumed with karma`);
    }
} finally {
    for (const [name, builder] of Object.entries(realResponses)) ServerResponse[name] = builder;
    global.invoke = realInvoke;
}

console.log('clan hall and castle escape checks passed');
process.exit(0);
