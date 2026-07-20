const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const Attack = invoke('GameServer/Actor/Attack');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const BasicAction = invoke('GameServer/Actor/Generics/BasicAction');
const AttackExec = invoke('GameServer/Actor/Generics/AttackExec');
const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
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
        fetchTitle: () => '',
        fetchRace: () => 0,
        fetchSex: () => 0,
        fetchClassId: () => 0,
        fetchLevel: () => 40,
        fetchExp: () => 0,
        fetchSp: () => 0,
        fetchStr: () => 40,
        fetchDex: () => 30,
        fetchCon: () => 43,
        fetchInt: () => 21,
        fetchWit: () => 11,
        fetchMen: () => 25,
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
        fetchCp: () => 0,
        fetchMaxCp: () => 0,
        fetchMaxLoad: () => 1000,
        fetchCollectivePAtk: () => 1,
        fetchCollectivePDef: () => 1,
        fetchCollectiveEvasion: () => 1,
        fetchCollectiveAccur: () => 1,
        fetchCollectiveCritical: () => 1,
        fetchCollectiveMAtk: () => 1,
        fetchCollectiveMDef: () => 1,
        fetchPvpFlag: () => 0,
        fetchKarma: () => 0,
        fetchCollectiveRunSpd: () => 1,
        fetchCollectiveWalkSpd: () => 1,
        fetchSwim: () => 0,
        fetchAtkSpdMultiplier: () => 1,
        fetchSize: () => 1,
        fetchHair: () => 0,
        fetchHairColor: () => 0,
        fetchFace: () => 0,
        fetchIsGM: () => 0,
        fetchPrivateStoreType: () => 0,
        fetchIsCrafter: () => 0,
        fetchPk: () => 0,
        fetchPvp: () => 0,
        fetchRecRemain: () => 0,
        fetchEvalScore: () => 0,
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
            fetchSeated: () => false,
            fetchWalkin: () => false,
            fetchCombats: () => false,
            fetchStateInvisible: () => false,
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

    const actionPet = npc(12077, 9000007);
    actionPet.model.isPet = true;
    actionPet.model.isSummon = true;
    actionPet.model.ownerId = session.actor.fetchId();
    session.actor.summon = null;
    session.actor.pet = actionPet;
    World.npc = { spawns: [actionPet], grid: {}, nextId: 9000008 };
    BasicAction(session, session.actor, { actionId: 0x0f });
    assert.strictEqual(actionPet.controlMode, 'follow', 'legacy pet follow action 15 should be handled');
    BasicAction(session, session.actor, { actionId: 0x11 });
    assert.strictEqual(actionPet.controlMode, 'idle', 'legacy pet cancel action 17 should be handled');
    session.actor.summon = { state: { fetchDead: () => true } };
    assert.strictEqual(SummonControl.activeSummon(session.actor), actionPet, 'live pet should remain controllable when a stale dead summon reference exists');

    const disconnectedLifetimeSummon = { timer: {}, state: { fetchDead: () => false } };
    assert.doesNotThrow(() => SummonControl.tickLifetime({ actor: null }, session.actor, disconnectedLifetimeSummon),
        'a queued summon lifetime tick must be harmless after its owner disconnects');

    const originalNpcSkillsForNpc = NpcSkills.forNpc;
    let clearedCooldownSummonTimers = 0;
    NpcSkills.forNpc = () => [{ fetchSelfId: () => 4230 }];
    try {
        session.packets.length = 0;
        SummonControl.useSkillAction(session, session.actor, {
            canUseSkill: () => false,
            attack: { clearTimers() { clearedCooldownSummonTimers += 1; } },
            automation: { abortAll() { throw new Error('a skill on reuse must not abort summon automation'); } }
        }, 0x20);
        assert.strictEqual(clearedCooldownSummonTimers, 0, 'a summon skill on reuse must preserve the active cast timers');
        assert(session.packets.some((packet) => packet[0] === 0x25), 'a summon skill on reuse should return ActionFailed');
    } finally {
        NpcSkills.forNpc = originalNpcSkillsForNpc;
    }

    actionPet.destructor(session);
    session.actor.pet = null;

    const strider = npc(12311, 990060);
    strider.model.selfId = 12526;
    strider.model.isPet = true;
    strider.model.isSummon = true;
    strider.model.ownerId = session.actor.fetchId();
    session.actor.pet = strider;
    World.npc = { spawns: [strider], grid: {}, nextId: 990061 };
    BasicAction(session, session.actor, { actionId: 0x26 });
    assert.strictEqual(session.actor.mounted, true, 'strider mount action should set mounted state');
    assert.strictEqual(World.npc.spawns.includes(strider), false, 'mounted strider should be removed from the visible NPC world');
    assert.strictEqual(SummonControl.activeSummon(session.actor), null, 'mounted strider should not accept off-world pet control actions');
    BasicAction(session, session.actor, { actionId: 0x26 });
    assert.strictEqual(session.actor.mounted, false, 'second mount action should dismount');
    assert.strictEqual(World.npc.spawns.includes(strider), true, 'dismount should restore the strider NPC to the world');
    strider.destructor(session);
    session.actor.pet = null;

    const corpseBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    corpseBackpack.items = [item(9, 1459, 2)];
    const corpseSession = sessionFor(corpseBackpack, buildSkill(1129, 1));
    const corpse = npc(1, 9000008);
    corpse.state.setDead(true);
    World.npc = { spawns: [corpse], grid: {}, nextId: 9000009 };
    const corpseSummon = SkillEffects.execute(corpseSession, corpseSession.actor, corpse, buildSkill(1129, 1), { attack });
    assert(corpseSummon.summon, 'Summon Reanimated Man should create a servitor from a dead NPC');
    assert.strictEqual(World.npc.spawns.some((spawn) => spawn.fetchId() === corpse.fetchId()), false, 'corpse summon should consume the source corpse');
    corpseSummon.summon.destructor(corpseSession);

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

    const hungryPet = npc(12077, 9000011);
    hungryPet.model.isPet = true;
    hungryPet.model.isSummon = true;
    hungryPet.model.ownerId = session.actor.fetchId();
    hungryPet.fetchCurrentFeed = () => 100;
    hungryPet.fetchMaxFeed = () => 248;
    session.actor.pet = hungryPet;
    World.npc = { spawns: [hungryPet], grid: {}, nextId: 9000012 };
    BasicAction(session, session.actor, { actionId: 0x13 });
    assert.strictEqual(session.actor.pet, hungryPet, 'hungry pet should not be returned to its control item');
    hungryPet.fetchCurrentFeed = () => 248;
    BasicAction(session, session.actor, { actionId: 0x13 });
    assert.strictEqual(session.actor.pet, null, 'fed pet should return to its control item through action 19');

    const feedingPet = npc(12077, 9000013);
    feedingPet.model.isPet = true;
    feedingPet.model.isSummon = true;
    feedingPet.model.ownerId = session.actor.fetchId();
    feedingPet.petData = { currentFeed: 100, maxFeed: 248, feedNormal: 2, feedBattle: 5 };
    feedingPet.fetchCurrentFeed = () => feedingPet.petData.currentFeed;
    feedingPet.fetchMaxFeed = () => feedingPet.petData.maxFeed;
    feedingPet.setCurrentFeed = (value) => { feedingPet.petData.currentFeed = value; };
    session.actor.pet = feedingPet;
    World.npc = { spawns: [feedingPet], grid: {}, nextId: 9000014 };
    SummonControl.tickPetFeed(session, session.actor, feedingPet);
    assert.strictEqual(feedingPet.fetchCurrentFeed(), 98, 'idle pet hunger should decrease by its sourced normal-feed cost every tick');
    assert.strictEqual(feedingPet.fetchStateRun(), false, 'hungry pet should switch to walking');
    feedingPet.controlMode = 'attack';
    feedingPet.state.setHits(true);
    SummonControl.tickPetFeed(session, session.actor, feedingPet);
    assert.strictEqual(feedingPet.fetchCurrentFeed(), 93, 'pet hunger should use its sourced battle-feed cost while attacking');
    feedingPet.destructor(session);

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

    const classSummonIds = [13, 25, 283, 299, 301, 1111, 1128, 1129, 1154, 1225, 1226, 1227, 1228, 1276, 1277, 1278, 1331, 1332, 1333, 1334, 7030, 7031, 7032];
    for (const selfId of classSummonIds) {
        const summonSkill = buildSkill(selfId, 1);
        const itemId = summonSkill.fetchItemConsumeId();
        const itemCount = summonSkill.fetchItemConsumeCount();
        const summonBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
        if (itemId && itemCount) summonBackpack.items = [item(10000 + selfId, itemId, itemCount)];
        const summonSession = sessionFor(summonBackpack, summonSkill, { mp: 10000 });
        const corpseTarget = [1129, 1154, 1334].includes(selfId) ? npc(1, 110000 + selfId) : summonSession.actor;
        corpseTarget.state?.setDead?.(true);
        World.npc = { spawns: corpseTarget === summonSession.actor ? [] : [corpseTarget], grid: {}, nextId: 120000 + selfId };
        const outcome = SkillEffects.execute(summonSession, summonSession.actor, corpseTarget, summonSkill, { attack });
        assert(outcome.summon, `${summonSkill.fetchName()} should spawn through the summon template fallback when needed`);
        outcome.summon.destructor(summonSession);
    }

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

    const hatchling = npc(12311, 9100010, { locX: 1000, locY: 2000, locZ: -50 });
    hatchling.model.isPet = true;
    hatchling.model.isSummon = true;
    hatchling.model.ownerId = boxerSession.actor.fetchId();
    hatchling.setCollectiveCastSpd(2000);
    hatchling.setMp(1000);
    const hatchlingTarget = npc(1, 9100011, { locX: 1010, locY: 2000, locZ: -50 });
    hatchlingTarget.setMaxHp(100000);
    hatchlingTarget.setHp(100000);
    assert.deepStrictEqual(
        NpcSkills.forNpc(hatchling).map((skill) => skill.fetchSelfId()).filter((id) => [4710, 4711].includes(id)),
        [4710, 4711],
        'Wind Hatchling should load both sourced special skills'
    );
    boxerSession.actor.pet = hatchling;
    boxerSession.actor.setDestId(hatchlingTarget.fetchId());
    World.npc = { spawns: [hatchling, hatchlingTarget], grid: {}, nextId: 9100012 };
    World.indexSpawnsInGrid?.();
    const packetCount = boxerSession.packets.length;
    await withFastTimers((realSetTimeout) => new Promise((resolve) => {
        BasicAction(boxerSession, boxerSession.actor, { actionId: 1003 });
        realSetTimeout(resolve, 20);
    }));
    assert(boxerSession.packets.slice(packetCount).some((packet) => packet[0] === 0x48), 'Wind Hatchling Wild Stun action should resolve to sourced NPC skill 4710');
    hatchling.destructor(boxerSession);
    hatchlingTarget.destructor(boxerSession);

    const merrow = npc(12490, 9100020, { locX: 1000, locY: 2000, locZ: -50 });
    merrow.model.isSummon = true;
    merrow.model.ownerId = boxerSession.actor.fetchId();
    merrow.model.summonSkillId = 1277;
    merrow.setCollectiveCastSpd(2000);
    merrow.setCollectiveMAtk(1000);
    merrow.setMp(1000);
    const merrowTarget = npc(1, 9100021, { locX: 1010, locY: 2000, locZ: -50 });
    merrowTarget.setMaxHp(100000);
    merrowTarget.setHp(100000);
    merrowTarget.setCollectiveMDef(1);
    const merrowAreaTarget = npc(1, 9100022, { locX: 1020, locY: 2000, locZ: -50 });
    merrowAreaTarget.setMaxHp(100000);
    merrowAreaTarget.setHp(100000);
    merrowAreaTarget.setCollectiveMDef(1);
    assert(NpcSkills.forNpc(merrow).some((skill) => skill.fetchSelfId() === 4137), 'Unicorn Merrow should gain Hydro Screw from its originating summon skill');
    boxerSession.actor.summon = merrow;
    boxerSession.actor.pet = null;
    boxerSession.actor.setDestId(merrowTarget.fetchId());
    World.npc = { spawns: [merrow, merrowTarget, merrowAreaTarget], grid: {}, nextId: 9100023 };
    World.indexSpawnsInGrid?.();
    const merrowPacketCount = boxerSession.packets.length;
    const savedMerrowRandom = Math.random;
    Math.random = () => 0;
    await withFastTimers((realSetTimeout) => new Promise((resolve) => {
        BasicAction(boxerSession, boxerSession.actor, { actionId: 0x2b });
        realSetTimeout(resolve, 20);
    }));
    Math.random = savedMerrowRandom;
    assert(boxerSession.packets.slice(merrowPacketCount).some((packet) => packet[0] === 0x48), 'Unicorn Merrow Hydro Screw action should cast the fallback summon skill');
    assert(merrowTarget.fetchHp() < merrowTarget.fetchMaxHp(), 'Hydro Screw should damage its selected primary target');
    assert(merrowAreaTarget.fetchHp() < merrowAreaTarget.fetchMaxHp(), 'Hydro Screw should damage nearby NPCs in its sourced 200 radius');
    merrow.destructor(boxerSession);
    merrowTarget.destructor(boxerSession);
    merrowAreaTarget.destructor(boxerSession);

    const bigBoom = npc(12187, 9100030);
    bigBoom.model.isSummon = true;
    bigBoom.model.summonSkillId = 301;
    bigBoom.setCollectiveMAtk(1000);
    bigBoom.setCollectiveCastSpd(2000);
    bigBoom.setMp(1000);
    const bigBoomTarget = npc(1, 9100031);
    bigBoomTarget.setMaxHp(100000);
    bigBoomTarget.setHp(100000);
    bigBoomTarget.setCollectiveMDef(1);
    boxerSession.actor.summon = bigBoom;
    boxerSession.actor.setDestId(bigBoomTarget.fetchId());
    World.npc = { spawns: [bigBoom, bigBoomTarget], grid: {}, nextId: 9100032 };
    World.indexSpawnsInGrid?.();
    BasicAction(boxerSession, boxerSession.actor, { actionId: 0x16 });
    assert.notStrictEqual(bigBoom.controlMode, 'attack', 'Big Boom should reject generic pet attack and use only Boom Attack');
    const bigBoomHp = bigBoom.fetchHp();
    const savedBigBoomRandom = Math.random;
    Math.random = () => 0;
    await withFastTimers((realSetTimeout) => new Promise((resolve) => {
        BasicAction(boxerSession, boxerSession.actor, { actionId: 0x2c });
        realSetTimeout(resolve, 20);
    }));
    Math.random = savedBigBoomRandom;
    assert(bigBoomTarget.fetchHp() < bigBoomTarget.fetchMaxHp(), 'Boom Attack should damage nearby enemies through its aura target');
    assert.strictEqual(bigBoom.fetchHp(), bigBoomHp, 'Boom Attack should not damage the summoner itself');
    bigBoom.destructor(boxerSession);
    bigBoomTarget.destructor(boxerSession);

    const soulless = npc(12070, 990050);
    soulless.model.isSummon = true;
    soulless.model.summonSkillId = 1278;
    soulless.setCollectiveMAtk(1000);
    soulless.setCollectiveCastSpd(2000);
    soulless.setMp(1000);
    const smokeTarget = npc(1, 990051);
    smokeTarget.setCollectiveMDef(1);
    boxerSession.actor.summon = soulless;
    boxerSession.actor.setDestId(smokeTarget.fetchId());
    World.npc = { spawns: [soulless, smokeTarget], grid: {}, nextId: 990052 };
    World.indexSpawnsInGrid?.();
    const savedSmokeRandom = Math.random;
    Math.random = () => 0;
    await withFastTimers((realSetTimeout) => new Promise((resolve) => {
        BasicAction(boxerSession, boxerSession.actor, { actionId: 0x24 });
        realSetTimeout(resolve, 20);
    }));
    Math.random = savedSmokeRandom;
    assert(smokeTarget.effects.toxic_smoke, 'Soulless Toxic Smoke should apply its poison DOT effect to the selected target');
    soulless.destructor(boxerSession);
    smokeTarget.destructor(boxerSession);

    const kai = npc(12187, 990040);
    kai.model.isSummon = true;
    kai.model.summonSkillId = 1276;
    const kaiShield = NpcSkills.forNpc(kai).find((skill) => skill.fetchSelfId() === 4378);
    assert(kaiShield, 'Kai the Cat should resolve Self Damage Shield from its originating summon skill');
    SkillEffects.execute(boxerSession, kai, kai, kaiShield, { attack });
    assert.strictEqual(EffectStats.add(kai, 'reflectDam'), 20, 'Self Damage Shield should grant sourced 20% reflected damage');
    const reflectedAttacker = npc(1, 990041);
    reflectedAttacker.setHp(1000);
    kai.setHp(1000);
    World.npc = { spawns: [kai, reflectedAttacker], grid: {}, nextId: 990042 };
    attack.hit(boxerSession, reflectedAttacker, kai, 100);
    assert.strictEqual(reflectedAttacker.fetchHp(), 980, 'Self Damage Shield should reflect sourced damage to an NPC attacker');
    kai.destructor(boxerSession);
    reflectedAttacker.destructor(boxerSession);

    console.log('Summon runtime checks passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
