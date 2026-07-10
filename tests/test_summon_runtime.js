const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const Attack = invoke('GameServer/Actor/Attack');
const BasicAction = invoke('GameServer/Actor/Generics/BasicAction');
const AttackExec = invoke('GameServer/Actor/Generics/AttackExec');
const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const Npc = invoke('GameServer/Npc/Npc');
const Select = invoke('GameServer/Actor/Generics/Select');
const Skill = invoke('GameServer/Model/Skill');
const SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const CubicControl = invoke('GameServer/Skills/CubicControl');
const SummonControl = invoke('GameServer/Npc/SummonControl');
const SkillExec = invoke('GameServer/Actor/Generics/SkillExec');
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
    const loc = {
        locX: options.locX ?? 1000,
        locY: options.locY ?? 2000,
        locZ: options.locZ ?? -50
    };
    const actor = {
        backpack,
        skillset: { fetchSkill: () => skill },
        summon: options.summon || null,
        fetchId: () => 2000001,
        fetchName: () => 'Summoner',
        fetchLevel: () => 40,
        fetchLocX: () => loc.locX,
        fetchLocY: () => loc.locY,
        fetchLocZ: () => loc.locZ,
        setLocXYZ(coords) {
            loc.locX = coords.locX;
            loc.locY = coords.locY;
            loc.locZ = coords.locZ;
        },
        fetchHead: () => 0,
        fetchRadius: () => 10,
        fetchDestId: () => destId,
        setDestId(value) { destId = value; },
        fetchIsOnline: () => true,
        fetchMp: () => mp,
        setMp(value) { mp = value; },
        fetchMaxMp: () => 100,
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
    assert.strictEqual(AttackExec.canAttackNpc(World.npc.spawns[0]), true, 'player attack path should treat an active servitor as damageable');
    assert.strictEqual(SkillExec.canTargetEnemyNpc(World.npc.spawns[0]), true, 'player skill path should treat an active servitor as an enemy target');
    assert.strictEqual(session.actor.summon, World.npc.spawns[0], 'actor should retain active summon reference');
    assert.strictEqual(World.npc.spawns[0].controlMode, 'follow', 'summoned servitor should enter native follow mode on spawn');
    assert.strictEqual(World.npc.spawns[0].followOwner, true, 'summoned servitor should follow owner by default');
    assert.strictEqual(World.npc.spawns[0].fetchStateRun(), true, 'summoned servitor should run rather than use its sourced walk speed');
    assert.strictEqual(backpack.fetchItemFromSelfId(1458), undefined, 'Summon Kat should consume sourced D crystal count');
    assert.strictEqual(session.actor.fetchMp(), 61, 'Summon Kat should consume sourced MP');
    assert(session.packets.some((packet) => packet[0] === 0x16), 'Summon Kat should broadcast NpcInfo for the servitor');
    World.npc.spawns[0].destructor(session);

    const deadPet = npc(12077, 9000009);
    deadPet.model.isPet = true;
    deadPet.model.isSummon = true;
    deadPet.model.ownerId = session.actor.fetchId();
    deadPet.state.setDead(true);
    deadPet.setHp(0);
    World.npc.spawns = [deadPet];
    World.user = { sessions: [session] };
    assert.strictEqual(SummonControl.revivePet(session, deadPet), true, 'dead pet should revive through the native summon lifecycle');
    assert.strictEqual(deadPet.state.fetchDead(), false, 'pet revival should clear its dead state');
    assert.strictEqual(deadPet.fetchHp(), deadPet.fetchMaxHp(), 'pet revival should restore its HP before resuming control');
    assert.strictEqual(deadPet.controlMode, 'follow', 'revived pet should resume following its owner');
    deadPet.destructor(session);

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

    const upkeepBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    upkeepBackpack.items = [item(29, 1458, 2)];
    const upkeepSkill = buildSkill(1111, 3);
    const upkeepSession = sessionFor(upkeepBackpack, upkeepSkill);
    World.npc = { spawns: [], grid: {}, nextId: 9000015 };
    await withFastTimers((realSetTimeout) => new Promise((resolve) => {
        attack.remoteHit(upkeepSession, upkeepSession.actor, upkeepSkill);
        realSetTimeout(resolve, 20);
    }));
    const upkeepSummon = upkeepSession.actor.summon;
    clearInterval(upkeepSummon.timer.summonLifetime);
    upkeepSummon.summonTimeRemaining = 1000;
    upkeepSummon.summonNextItemConsumeTime = 500;
    SummonControl.tickLifetime(upkeepSession, upkeepSession.actor, upkeepSummon);
    assert.strictEqual(upkeepBackpack.fetchItemFromSelfId(1458), undefined, 'servitor upkeep should consume the sourced ongoing crystal count at its lifetime checkpoint');
    assert.strictEqual(upkeepSession.actor.summon, upkeepSummon, 'servitor should remain active while the ongoing crystal cost can be paid');
    upkeepSummon.summonTimeRemaining = 100;
    SummonControl.tickLifetime(upkeepSession, upkeepSession.actor, upkeepSummon);
    assert.strictEqual(upkeepSession.actor.summon, null, 'servitor should auto-unsummon when its sourced lifetime expires');

    const cubicBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    cubicBackpack.items = [item(30, 1458, 5)];
    const cubicSkill = buildSkill(1279, 1);
    const cubicSession = sessionFor(cubicBackpack, cubicSkill);
    SkillEffects.execute(cubicSession, cubicSession.actor, cubicSession.actor, cubicSkill);
    assert.strictEqual(cubicSession.actor.cubics.size, 1, 'Summon Binding Cubic should create a cubic instance instead of a servitor NPC');
    assert.strictEqual(cubicSession.actor.cubics.get(6).skillId, 1279, 'Binding Cubic should retain its sourced cubic id and summon skill');
    assert.strictEqual(cubicBackpack.fetchItemFromSelfId(1458), undefined, 'Summon Binding Cubic should consume sourced crystals');
    clearTimeout(cubicSession.actor.cubics.get(6).expireTimer);
    clearInterval(cubicSession.actor.cubics.get(6).actionTimer);

    const lifeCubicBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    lifeCubicBackpack.items = [item(31, 1458, 6)];
    const lifeCubicSkill = buildSkill(67, 1);
    const lifeCubicSession = sessionFor(lifeCubicBackpack, lifeCubicSkill);
    let lifeCubicHp = 20;
    lifeCubicSession.actor.fetchHp = () => lifeCubicHp;
    lifeCubicSession.actor.setHp = (value) => { lifeCubicHp = value; };
    SkillEffects.execute(lifeCubicSession, lifeCubicSession.actor, lifeCubicSession.actor, lifeCubicSkill);
    const lifeCubic = lifeCubicSession.actor.cubics.get(3);
    CubicControl.act(lifeCubicSession, lifeCubicSession.actor, lifeCubic);
    await new Promise((resolve) => setImmediate(resolve));
    assert(lifeCubicHp > 20, 'Life Cubic should periodically heal its owner with sourced Cubic Heal power');
    assert(lifeCubicSession.packets.some((packet) => packet[0] === 0x76), 'Life Cubic proc should broadcast MagicSkillLaunched');
    clearTimeout(lifeCubic.expireTimer);
    clearInterval(lifeCubic.actionTimer);

    const massCubicBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    massCubicBackpack.items = [item(32, 1458, 20)];
    const massCubicSkill = buildSkill(1328, 1);
    const massCubicSession = sessionFor(massCubicBackpack, massCubicSkill);
    const massCubicCompanion = sessionFor(new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] }), massCubicSkill);
    massCubicCompanion.followPlayerSession = massCubicSession;
    massCubicCompanion.partyCompanion = true;
    World.user = { sessions: [massCubicSession, massCubicCompanion] };
    SkillEffects.execute(massCubicSession, massCubicSession.actor, massCubicSession.actor, massCubicSkill);
    assert.strictEqual(massCubicSession.actor.cubics.get(1).sourceId, massCubicSession.actor.fetchId(), 'Mass Storm Cubic should retain the caster as cubic source');
    assert.strictEqual(massCubicCompanion.actor.cubics.get(1).sourceId, massCubicSession.actor.fetchId(), 'Mass Storm Cubic should apply the cubic to each active party companion');
    assert.strictEqual(massCubicBackpack.fetchItemFromSelfId(1458), undefined, 'Mass Storm Cubic should consume the sourced crystals only once for the whole party');
    [massCubicSession.actor, massCubicCompanion.actor].forEach((member) => {
        clearTimeout(member.cubics.get(1).expireTimer);
        clearInterval(member.cubics.get(1).actionTimer);
    });

    const cubicPvpSession = sessionFor(new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] }), summonKat, { destId: 3000002 });
    const cubicPvpTargetSession = sessionFor(new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] }), summonKat);
    cubicPvpTargetSession.actor.fetchId = () => 3000002;
    cubicPvpTargetSession.actor.fetchPvpFlag = () => 1;
    World.user = { sessions: [cubicPvpSession, cubicPvpTargetSession] };
    assert.strictEqual(await CubicControl.selectedEnemy(cubicPvpSession, cubicPvpSession.actor), cubicPvpTargetSession.actor, 'offensive cubic should accept a flagged PvP target inside the sourced 900 range');
    cubicPvpTargetSession.actor.setLocXYZ({ locX: 2500, locY: 2000, locZ: -50 });
    assert.strictEqual(await CubicControl.selectedEnemy(cubicPvpSession, cubicPvpSession.actor), null, 'offensive cubic should reject targets outside the sourced 900 range');

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
    World.npc.spawns[0].destructor(queenSession);

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
    Select(controlSession, controlSession.actor, { id: summon.fetchId() });
    await new Promise((resolve) => setTimeout(resolve, 10));
    Select(controlSession, controlSession.actor, { id: summon.fetchId() });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert(controlSession.packets.some((packet) => packet[0] === 0xb0), 'second click on owned servitor should open PetStatusShow');
    assert(controlSession.packets.some((packet) => packet[0] === 0xb1), 'owned servitor window should receive PetInfo before opening');
    assert(controlSession.packets.some((packet) => packet[0] === 0xb5), 'owned servitor window should receive PetStatusUpdate before opening');
    controlSession.packets = [];
    summon.setHp(summon.fetchHp() - 1);
    summon.broadcastVitals();
    assert(controlSession.packets.some((packet) => packet[0] === 0xb5), 'summon vitality changes should refresh the owner PetStatusUpdate');

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

    const rechargeBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    rechargeBackpack.items = [item(5, 1458, 3)];
    const boxerSession = sessionFor(rechargeBackpack, buildSkill(1226, 1), { mp: 100 });
    World.user = { sessions: [boxerSession] };
    World.npc = { spawns: [], grid: {}, nextId: 9000040 };

    await withFastTimers((realSetTimeout) => new Promise((resolve) => {
        attack.remoteHit(boxerSession, boxerSession.actor, buildSkill(1226, 1));
        realSetTimeout(resolve, 20);
    }));

    const boxer = boxerSession.actor.summon;
    boxerSession.actor.setMp(20);
    boxer.setCollectiveCastSpd(2000);
    boxer.setMp(1000);
    await withFastTimers((realSetTimeout) => new Promise((resolve) => {
        BasicAction(boxerSession, boxerSession.actor, { actionId: 0x2d });
        realSetTimeout(resolve, 20);
    }));
    assert(boxerSession.actor.fetchMp() > 20, 'Unicorn Boxer pet action should recharge owner MP with npc skill 4025');
    assert(boxerSession.packets.some((packet) => packet[0] === 0x48), 'servitor skill action should broadcast MagicSkillUse');
    BasicAction(boxerSession, boxerSession.actor, { actionId: 0x34 });

    console.log('Summon runtime checks passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
