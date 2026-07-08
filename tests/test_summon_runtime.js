const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const Attack = invoke('GameServer/Actor/Attack');
const BasicAction = invoke('GameServer/Actor/Generics/BasicAction');
const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const Npc = invoke('GameServer/Npc/Npc');
const Skill = invoke('GameServer/Model/Skill');
const World = invoke('GameServer/World/World');
const Database = invoke('Database');

Database.updateItemAmount = () => Promise.resolve();
Database.deleteItem = () => Promise.resolve();

function item(id, selfId, amount) {
    return new Item(id, {
        selfId,
        kind: 'Other.None',
        amount,
        stackable: true,
        consumable: false,
        name: `item_${selfId}`
    });
}

function buildSkill(selfId, level) {
    const data = DataCache.skills.find((entry) => entry.selfId === selfId);
    const levelData = data.levels.find((entry) => entry.level === level);
    return new Skill({
        ...utils.crushOb(data),
        ...levelData
    });
}

function sessionFor(backpack, skill, options = {}) {
    let mp = options.mp ?? 100;
    let casts = false;
    let destId = options.destId;
    const actor = {
        backpack,
        skillset: { fetchSkill: () => skill },
        summon: options.summon || null,
        fetchId: () => 2000001,
        fetchName: () => 'Summoner',
        fetchLocX: () => 1000,
        fetchLocY: () => 2000,
        fetchLocZ: () => -50,
        fetchHead: () => 0,
        fetchRadius: () => 10,
        fetchDestId: () => destId,
        setDestId(value) { destId = value; },
        fetchIsOnline: () => true,
        fetchMp: () => mp,
        setMp(value) { mp = value; },
        fetchHp: () => 100,
        setHp() {},
        fetchMaxHp: () => 100,
        fetchCollectiveCastSpd: () => 333,
        fetchCollectiveAtkSpd: () => 333,
        statusUpdateVitals() {},
        isDead: () => false,
        automation: { replenishVitals() {} },
        state: {
            fetchDead: () => false,
            setHits() {},
            setCasts(value) { casts = value; },
            fetchCasts: () => casts
        }
    };

    return {
        actor,
        packets: [],
        dataSendToMe(packet) {
            this.packets.push(packet);
        },
        dataSendToMeAndOthers(packet) {
            this.packets.push(packet);
        }
    };
}

function npc(selfId, id, coords = {}) {
    const data = DataCache.npcs.find((entry) => entry.selfId === selfId);
    return new Npc(id, {
        ...utils.crushOb(data),
        locX: coords.locX ?? 1040,
        locY: coords.locY ?? 2000,
        locZ: coords.locZ ?? -50,
        head: 0
    });
}

async function withFastTimers(callback) {
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => realSetTimeout(fn, 0);
    try {
        await callback(realSetTimeout);
    } finally {
        global.setTimeout = realSetTimeout;
    }
}

(async () => {
    const summonKat = buildSkill(1111, 1);
    const backpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    backpack.items = [item(1, 1458, 3)];
    const session = sessionFor(backpack, summonKat);
    const attack = new Attack();
    World.npc = { spawns: [], grid: {}, nextId: 9000000 };

    await withFastTimers((realSetTimeout) => new Promise((resolve) => {
        attack.remoteHit(session, session.actor, summonKat);
        realSetTimeout(resolve, 20);
    }));

    assert.strictEqual(World.npc.spawns.length, 1, 'Summon Kat should spawn one servitor NPC');
    assert.strictEqual(World.npc.spawns[0].fetchSelfId(), 12006, 'Summon Kat level 1 should spawn sourced npcId 12006');
    assert.strictEqual(World.npc.spawns[0].fetchOwnerId(), session.actor.fetchId(), 'summoned servitor should keep owner id');
    assert.strictEqual(World.npc.spawns[0].fetchIsSummon(), true, 'summoned servitor should be marked as summon');
    assert.strictEqual(session.actor.summon, World.npc.spawns[0], 'actor should retain active summon reference');
    assert.strictEqual(backpack.fetchItemFromSelfId(1458), undefined, 'Summon Kat should consume sourced D crystal count');
    assert.strictEqual(session.actor.fetchMp(), 61, 'Summon Kat should consume sourced MP');
    assert(session.packets.some((packet) => packet[0] === 0x16), 'Summon Kat should broadcast NpcInfo for the servitor');

    const noCrystalBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    noCrystalBackpack.items = [item(2, 1458, 2)];
    const noCrystalSession = sessionFor(noCrystalBackpack, summonKat);
    World.npc = { spawns: [], grid: {}, nextId: 9000010 };

    await withFastTimers((realSetTimeout) => new Promise((resolve) => {
        attack.remoteHit(noCrystalSession, noCrystalSession.actor, summonKat);
        realSetTimeout(resolve, 20);
    }));

    assert.strictEqual(World.npc.spawns.length, 0, 'summon should not spawn without required crystals');
    assert.strictEqual(noCrystalBackpack.fetchItemFromSelfId(1458).fetchAmount(), 2, 'failed summon should not consume crystals');
    assert.strictEqual(noCrystalSession.actor.fetchMp(), 100, 'failed summon should not consume MP');

    const queenCat = buildSkill(1331, 1);
    const queenBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    queenBackpack.items = [item(3, 1459, 1)];
    const queenSession = sessionFor(queenBackpack, queenCat);
    World.npc = { spawns: [], grid: {}, nextId: 9000020 };

    await withFastTimers((realSetTimeout) => new Promise((resolve) => {
        attack.remoteHit(queenSession, queenSession.actor, queenCat);
        realSetTimeout(resolve, 20);
    }));

    assert.strictEqual(World.npc.spawns.length, 1, 'third-class cat servitor should spawn even when exact stats template is missing');
    assert.strictEqual(World.npc.spawns[0].fetchSelfId(), 13137, 'Summon Queen of Cat should preserve sourced requested npcId');
    assert.strictEqual(World.npc.spawns[0].fetchName(), 'Queen of Cat', 'fallback summon should use skill-derived display name');
    assert.strictEqual(queenBackpack.fetchItemFromSelfId(1459), undefined, 'Summon Queen of Cat should consume sourced B crystal count');

    const controlBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    controlBackpack.items = [item(4, 1458, 3)];
    const controlSession = sessionFor(controlBackpack, summonKat);
    World.user = { sessions: [controlSession] };
    World.npc = { spawns: [], grid: {}, nextId: 9000030 };
    World.items = { spawns: [], nextId: 9500000 };

    await withFastTimers((realSetTimeout) => new Promise((resolve) => {
        attack.remoteHit(controlSession, controlSession.actor, summonKat);
        realSetTimeout(resolve, 20);
    }));

    const summon = controlSession.actor.summon;
    summon.setCollectiveAtkSpd(2000);
    summon.setCollectivePAtk(40);
    const target = npc(1, 9100000, { locX: summon.fetchLocX(), locY: summon.fetchLocY(), locZ: summon.fetchLocZ() });
    target.setMaxHp(100000);
    target.setHp(100000);
    target.setCollectivePDef(1);
    World.npc.spawns.push(target);
    World.indexSpawnsInGrid?.();
    controlSession.actor.setDestId(target.fetchId());
    const targetHp = target.fetchHp();
    const savedRandom = Math.random;
    Math.random = () => 0.5;

    await new Promise((resolve) => {
        BasicAction(controlSession, controlSession.actor, { actionId: 0x16 });
        setTimeout(resolve, 700);
    });
    Math.random = savedRandom;

    assert(target.fetchHp() < targetHp, 'servitor attack action should damage selected attackable NPC');
    assert(controlSession.packets.some((packet) => packet[0] === 0x05), 'servitor attack should broadcast an Attack packet');

    BasicAction(controlSession, controlSession.actor, { actionId: 0x17 });
    assert.strictEqual(summon.controlMode, 'idle', 'servitor cancel action should stop attack mode');

    BasicAction(controlSession, controlSession.actor, { actionId: 0x34 });
    assert.strictEqual(controlSession.actor.summon, null, 'servitor unsummon action should clear owner summon reference');
    assert.strictEqual(World.npc.spawns.some((spawn) => spawn.fetchId() === summon.fetchId()), false, 'servitor unsummon action should remove summon from world');
    target.destructor(controlSession);

    console.log('Summon runtime checks passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
