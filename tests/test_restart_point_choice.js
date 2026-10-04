const assert = require('assert');

require('../src/Global');

// One restart-point choice, three callers: the player's restart after death
// (RestartPoint), the recall skill of a Scroll of Escape (C4SkillEffects) and
// a bot's death respawn (BotAI). With karma the town's PK point, otherwise
// the town gatekeeper. The points below are pinned literally, per map cell.
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const SkillModel = invoke('GameServer/Model/Skill');
const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const BotAI = invoke('GameServer/Bot/BotAI');

const CELLS = {
    // Floran's map cell 20_23: the gatekeeper restart is Dion's (V7), the PK
    // points stay Floran's.
    floran_20_23: {
        loc: { locX: 17144, locY: 170156, locZ: -3504 },
        gatekeeper: { locX: 15681, locY: 142885, locZ: -2704 },
        pk: [{ locX: 17555, locY: 170393, locZ: -3451 }, { locX: 17299, locY: 170341, locZ: -3451 },
            { locX: 17931, locY: 170381, locZ: -3451 }]
    },
    dion_fields: {
        loc: { locX: 22000, locY: 140000, locZ: -3000 },
        gatekeeper: { locX: 15681, locY: 142885, locZ: -2704 },
        pk: [{ locX: 17555, locY: 170393, locZ: -3400 }, { locX: 17299, locY: 170341, locZ: -3400 },
            { locX: 17931, locY: 170381, locZ: -3400 }]
    },
    giran: {
        loc: { locX: 83000, locY: 148000, locZ: -3400 },
        gatekeeper: { locX: 83446, locY: 147904, locZ: -3400 },
        pk: [{ locX: 74450, locY: 144238, locZ: -3730 }, { locX: 79543, locY: 142050, locZ: -3500 },
            { locX: 75501, locY: 147178, locZ: -3530 }]
    },
    // No region: the nearest town, and no PK points, so karma also lands at
    // its gatekeeper.
    nowhere: {
        loc: { locX: -250000, locY: -250000, locZ: 0 },
        gatekeeper: { locX: -45214, locY: -112512, locZ: -256 },
        pk: [{ locX: -45214, locY: -112512, locZ: -256 }, { locX: -45214, locY: -112512, locZ: -256 },
            { locX: -45214, locY: -112512, locZ: -256 }]
    }
};
const RANDOMS = [0, 0.5, 0.99];
// karma value -> expects the PK point
const KARMAS = [[0, false], [undefined, false], [-5, false], [1, true], [720, true]];

function actorAt(loc, karma) {
    const actor = {
        fetchId: () => 77,
        fetchLocX: () => loc.locX,
        fetchLocY: () => loc.locY,
        fetchLocZ: () => loc.locZ,
        fetchKarma: () => karma,
        fetchPrivateStore: () => false,
        fetchPrivateStoreType: () => 0,
        isDead: () => false,
        isInOlympiadMode: () => false,
        state: { fetchDead: () => false }
    };
    actor.session = { actor };
    return actor;
}

function withRandom(value, callback) {
    const realRandom = Math.random;
    Math.random = () => value;
    try {
        return callback();
    } finally {
        Math.random = realRandom;
    }
}

function withInvoke(overrides, callback) {
    const realInvoke = global.invoke;
    global.invoke = (module) => (module in overrides ? overrides[module] : realInvoke(module));
    try {
        return callback();
    } finally {
        global.invoke = realInvoke;
    }
}

function restartDestination(actor) {
    let destination = null;
    const generics = {
        revive: () => {},
        teleportTo: (_session, _actor, coords) => { destination = coords; }
    };
    const response = { userInfo: () => null, actionFailed: () => null };
    withInvoke({ [path.actor]: generics, 'GameServer/Network/Response': response }, () => {
        delete require.cache[require.resolve('../src/GameServer/Network/Request/RestartPoint')];
        const RestartPoint = require('../src/GameServer/Network/Request/RestartPoint');
        actor.isDead = () => true;
        actor.state = { fetchDead: () => true };
        RestartPoint.consume({ actor, dataSendToMe: () => {} }, { location: 0 });
    });
    return destination;
}

const recallData = DataCache.skills.find((skill) => skill.selfId === 2013);
const recallSkill = new SkillModel({ ...utils.crushOb(recallData), ...recallData.levels[0] });
function recallDestination(actor) {
    let destination = null;
    withInvoke({ 'GameServer/Actor/Generics/TeleportTo': (_session, _actor, coords) => { destination = coords; } }, () => {
        assert.strictEqual(C4SkillEffects.execute(actor.session, actor, actor, recallSkill).recalled, true);
    });
    return destination;
}

function botDestination(actor, session = { plan: 'hunting' }) {
    return BotAI.getDeathRespawnTarget(session, actor, false);
}

for (const [cellName, cell] of Object.entries(CELLS)) {
    for (const [karma, toPkPoint] of KARMAS) {
        RANDOMS.forEach((random, index) => {
            const expected = toPkPoint ? cell.pk[index] : cell.gatekeeper;
            const label = `${cellName} karma ${karma} random ${random}`;
            withRandom(random, () => {
                assert.deepStrictEqual(restartDestination(actorAt(cell.loc, karma)), expected, `restart: ${label}`);
                assert.deepStrictEqual(recallDestination(actorAt(cell.loc, karma)), expected, `recall: ${label}`);
                assert.deepStrictEqual(botDestination(actorAt(cell.loc, karma)), expected, `bot respawn: ${label}`);
            });
        });
    }
}

// A bot's own priorities around the choice: a PK hunter's anchor first, then
// karma (before its shop spot), then the shop spot, then the gatekeeper.
const giran = CELLS.giran;
const anchor = { locX: 1, locY: 2, locZ: 3 };
const shopSpot = { locX: 82000, locY: 148500, locZ: -3400 };
withRandom(0.5, () => {
    assert.deepStrictEqual(botDestination(actorAt(giran.loc, 720), { pkProfile: { anchor } }), anchor);
    assert.deepStrictEqual(botDestination(actorAt(giran.loc, 720), { plan: 'merchant', initialSpawnCoord: shopSpot }),
        giran.pk[1], 'a merchant with karma restarts at the PK point');
    assert.deepStrictEqual(botDestination(actorAt(giran.loc, 0), { plan: 'merchant', initialSpawnCoord: shopSpot }),
        shopSpot, 'a merchant without karma returns to its shop spot');
});

console.log('Restart point choice checks passed');
