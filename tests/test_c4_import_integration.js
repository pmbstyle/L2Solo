const assert = require('node:assert/strict');
const { createWorld, Service, Database, DataCache } = require('./helpers/c4QuestHarness');
const Actor = invoke('GameServer/Actor/Actor');

// Use the production actor layout, including persisted flags under actor.model.
async function playerSession(world, id) {
    const model = await world.character(id);
    const session = {
        packets: [],
        dataSendToMe(packet) { this.packets.push(packet); },
        dataSendToOthers() {},
        dataSendToMeAndOthers(packet) { this.packets.push(packet); }
    };
    session.actor = new Actor(session, {
        ...model, items: await Database.fetchItems(id), paperdoll: utils.tupleAlloc(16, {})
    });
    await Service.ensureLoaded(session);
    return session;
}

async function beginnerReceiptSurvivesRelog(world) {
    let session = await playerSession(world, 9001);
    assert.equal(session.actor.fetchNewbie(), 1);
    await world.event(session, 257, 'start', 7039);
    await Service.giveItem(session, 752, 1);
    await world.talk(session, 7039);
    assert.equal(await world.amount(9001, 5789), 6000, 'real player receives beginner shots');
    assert.equal(session.actor.fetchNewbieShotsReceived(), 1, 'live actor retains the receipt');
    await world.reopen(9001);
    session = await playerSession(world, 9001);
    assert.equal(session.actor.fetchNewbieShotsReceived(), 1, 'receipt reloads from the model');
    await world.event(session, 260, 'start', 7221);
    await Service.giveItem(session, 1114, 1);
    await world.talk(session, 7221);
    assert.equal(await world.amount(9001, 5789), 6000, 'another quest cannot pay shots again');
    assert.equal(await world.amount(9001, 1114), 0, 'ordinary hand-in still succeeds after relog');
    assert.equal(await world.amount(9001, 57), 22, 'both ordinary bounty payments are committed');
}

async function sinEaterRewardIsAtomic(world) {
    let session = await world.session(9002);
    await Service.giveItem(session, 4425, 1);
    await Database.execute(['UPDATE items SET petData = ? WHERE characterId = ? AND selfId = 4425',
        [JSON.stringify({ version: 1, npcId: 12564, level: 21, exp: 0, hp: 31, mp: 26 }), 9002]]);
    await Database.setCharacterQuest(9002, 422, 'started', { cond: '16', level: '20' });
    session = await world.session(9002);
    const before = await world.questRow(9002, 422);
    await Database.execute([`CREATE TRIGGER reject_quest_pk BEFORE UPDATE OF pk ON characters
        BEGIN SELECT RAISE(ABORT, 'test PK write failure'); END`]);
    await assert.rejects(world.event(session, 422, 'repent', 7981), /test PK write failure/);
    assert.equal(await world.amount(9002, 4425), 1, 'failure rolls back collar consumption');
    assert.equal(await world.amount(9002, 4426), 0, 'failure rolls back the replacement');
    assert.equal((await world.character(9002)).pk, 20);
    assert.equal(session.actor.fetchPk(), 20, 'failure leaves the live PK count unchanged');
    assert.deepEqual(await world.questRow(9002, 422), before, 'quest state also rolls back');
    await Database.execute(['DROP TRIGGER reject_quest_pk']);
    const random = Math.random;
    Math.random = () => 0.35;
    try { await world.event(session, 422, 'repent', 7981); }
    finally { Math.random = random; }
    session = await world.reopen(9002);
    assert.equal(session.actor.fetchPk(), 16, 'PK reduction survives restart');
    assert.equal(await world.amount(9002, 4425), 0);
    assert.equal(await world.amount(9002, 4426), 1);
    assert.ok((await world.links(session, 7981, 422)).includes('reissue'),
        'remaining sins offer renewal without aborting the quest');
    await world.event(session, 422, 'reissue', 7981);
    assert.equal(await world.amount(9002, 4425), 1);
    assert.equal(await world.amount(9002, 4426), 0);
}

function keepersUseExistingDungeons() {
    const dungeons = invoke('GameServer/World/C4SevenSignsDungeonTeleports').DUNGEONS;
    const pairs = [[8494,8095],[8495,8114],[8496,8096],[8497,8115],[8498,8097],
        [8499,8116],[8500,8098],[8501,8117],[8502,8099],[8503,8100],[8504,8102],
        [8505,8101],[8506,8118],[8507,8119]];
    for (const [keeper, portal] of pairs) {
        const point = DataCache.npcSpawns.flatMap(g => g.spawns || [])
            .find(s => s.selfId === keeper).coords[0];
        const [x,y,z] = dungeons.find(d => d.outside.npcId === portal).outside.destination;
        assert.ok(Math.hypot(point.locX-x, point.locY-y) < 700 && Math.abs(point.locZ-z) < 100,
            `Dimension Keeper ${keeper} must stand at its existing C4 dungeon`);
    }
}

async function bountyUsesServerRates(world) {
    const session = await world.session(9003);
    await world.event(session, 275, 'start', 7567);
    const random = Math.random;
    Math.random = () => 0.999;
    try {
        for (let i = 0; i < 70; i++) await world.kill(session, 316);
    } finally { Math.random = random; }
    const previous = options.default.General.questAdenaRate;
    options.default.General.questAdenaRate = 2;
    try { await world.event(session, 275, 'reward', 7567); }
    finally { options.default.General.questAdenaRate = previous; }
    assert.equal(await world.amount(9003, 57), 8400, 'imported bounty honors quest adena rates');
}

async function questExperienceLevelsThePlayer(world) {
    const previousExp = DataCache.experience[10] - 1;
    await Database.execute(['UPDATE characters SET exp = ? WHERE id = 9004', [previousExp]]);
    const session = await playerSession(world, 9004);
    await world.event(session, 303, 'start', 7029);
    await Service.giveItem(session, 963, 10);
    await world.talk(session, 7029);
    // Let the ordinary asynchronous skill refresh finish before closing SQLite.
    await new Promise(resolve => setImmediate(resolve));
    await invoke('GameServer/Persistence/CharacterWriteQueue').flushCharacter(9004);
    assert.equal(session.actor.fetchLevel(), 11, 'quest XP runs the normal level-up path');
    assert.equal(session.actor.fetchExp(), previousExp + 2000);
    const persisted = await world.character(9004);
    assert.equal(persisted.level, 11);
    assert.equal(persisted.exp, previousExp + 2000);
    assert.equal(await world.amount(9004, 963), 0);
    assert.equal(await world.amount(9004, 57), 1000);
    assert.equal((await world.questRow(9004, 303)).state, 'created');
}

(async () => {
    const world = await createWorld([
        { id: 9001, race: 1, classId: 18, level: 10, newbie: 1 },
        { id: 9002, race: 0, classId: 0, level: 20, pk: 20 },
        { id: 9003, race: 3, classId: 44, level: 20 },
        { id: 9004, race: 0, classId: 0, level: 10 }
    ], 'c4-import-integration');
    try {
        keepersUseExistingDungeons();
        await beginnerReceiptSurvivesRelog(world);
        await sinEaterRewardIsAtomic(world);
        await bountyUsesServerRates(world);
        await questExperienceLevelsThePlayer(world);
        console.log('Imported quests: production actor, restart, atomic PK reward and C4 locations passed');
    } finally { await world.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
