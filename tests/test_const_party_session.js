const assert = require('node:assert/strict');
const fs = require('node:fs');
const fixture = require('./helpers/isolatedSocialDatabase')('l2-const-party');
require('./helpers/databaseIsolation');
require('../src/Global');
fixture.assertConfigured(options.default);
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Friends = invoke('GameServer/Bot/AI/BotFriendship'), Const = invoke('GameServer/Bot/AI/ConstPartySession');
const Companion = invoke('GameServer/Bot/AI/PartyCompanionService'), Manager = invoke('GameServer/Bot/BotManager');
const World = invoke('GameServer/World/World'), Availability = invoke('GameServer/Bot/AI/BotAvailability');
const originalNamedInvite = World.inviteBotByName;
const SavedStats = require('../src/GameServer/Bot/SavedStats');
const saved = [];
function patch(object, key, value) { const previous = object[key]; saved.push(() => { object[key] = previous; }); object[key] = value; }
const query = (sql, params = []) => DB.execute([sql, params]);
const row = async id => (await query('SELECT * FROM bot_life_state WHERE characterId=?', [id]))[0];
const stats = row => SavedStats.merge(row.statsJson, row.mindJson);
async function seed(id, activity = 'hunting', extra = {}) {
    const account = id === 9001 ? 'const_player' : `bot_const_${id}`;
    await query('INSERT INTO accounts(username,password) VALUES (?,?)', [account, 'test']);
    await query(`INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES (?,?,?,0,0,100,100,0,0,0,0,10,20,30)`, [id, account, `Const${id}`]);
    if (id === 9001) return;
    const at = Date.now();
    await query(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,
        locX,locY,locZ,activityStartedAt,nextResolveAt,lastResolvedAt,updatedAt,statsJson,inventorySummary)
        VALUES (?,?,?,20,'cold',?,10,20,30,?,?,?,?,?,'{}')`,
    [id, account, `Const${id}`, activity, at - 1000, at + 60000, at - 1000, at, JSON.stringify(extra)]);
    await query("INSERT INTO bot_friendships(playerId,botId,status,createdAt,updatedAt) VALUES (9001,?,'accepted',?,?)", [id, at, at]);
    Life.acceptLifecycleRow(await row(id));
}
function actor(id) {
    return { fetchId: () => id, fetchName: () => `Const${id}`, fetchLevel: () => id === 9001 ? 78 : 20,
        fetchCp: () => 100, fetchMaxCp: () => 100, fetchHp: () => 100, fetchMaxHp: () => 100,
        fetchMp: () => 100, fetchMaxMp: () => 100, fetchClassId: () => 0,
        fetchClanId: () => 0, fetchIsOnline: () => true, fetchLocX: () => 10, fetchLocY: () => 20,
        fetchLocZ: () => 30, unselect() {}, destructor() {}, state: { setHits() {}, setCasts() {} },
        attack: { abortCast() {}, clearTimers() {}, resetQueuedEvent() {} }, automation: { abortAll() {}, stopReplenish() {} } };
}
async function main() {
    DB.init(); await Life.init(); await seed(9001);
    const at = Date.now(), travel = { startedAt: at - 1000, arrivalAt: at + 60000,
        run: { startAt: at, endAt: at + 60000 }, to: { locX: 1000, locY: 2000, locZ: 30 } };
    await seed(101, 'traveling', { travel, equipmentPlan: { strategy: 'market' }, classId: 0 });
    await query("INSERT INTO interaction_relations(ownerId,kind,targetId,rowJson) VALUES (101,'character',9001,?)", [JSON.stringify({ trust: 6, social: {} })]);
    assert.equal((await Friends.request({ characterId: 9001 }, { characterId: 101 })).ok, true, 'six trust accepts friendship');
    const initial = await row(101);
    let paused = await DB.pauseConstPartyActivity({ characterId: 101, playerId: 9001 });
    assert(paused.ok); assert.equal(paused.rows[0].phase, 'hot'); assert.equal(stats(paused.rows[0]).travel, undefined);
    const stale = await DB.handoffColdSimulationToMain({ characterId: 101, expectedRevision: initial.simulationRevision });
    assert.equal(stale.reason, 'stale_revision', 'a worker forecast cannot mutate the paused activity');
    await query('UPDATE bot_life_state SET level=25,exp=12345,adena=999 WHERE characterId=101');
    let result = await DB.releaseConstPartyActivity({ characterId: 101, playerId: 9001 });
    let restored = result.rows[0], resumed = stats(restored), elapsed = restored.updatedAt - stats(paused.rows[0]).constPartySession.saved.at;
    assert.equal(restored.activity, 'traveling'); assert.equal(restored.phase, 'cold');
    assert.equal(resumed.travel.arrivalAt, travel.arrivalAt + elapsed);
    assert.equal(resumed.travel.run.endAt, travel.run.endAt + elapsed);
    assert.equal(restored.nextResolveAt, initial.nextResolveAt + elapsed);
    assert.equal(restored.level, 25); assert.equal(restored.exp, 12345); assert.equal(restored.adena, 999);
    assert.equal(resumed.constPartySession, undefined); assert.equal(resumed.equipmentPlan.strategy, 'market');

    // A session saved with fractional clocks resumes whole: a bot takes no command otherwise.
    await seed(191);
    await query(`UPDATE bot_life_state SET activityStartedAt=activityStartedAt+0.7,nextResolveAt=?,
        statsJson=json_set(statsJson,'$.restUntil',?) WHERE characterId=191`, [at + 600000.5, at + 600000.5]);
    assert.equal((await DB.pauseConstPartyActivity({ characterId: 191, playerId: 9001 })).ok, true);
    await DB.releaseConstPartyActivity({ characterId: 191, playerId: 9001 });
    const wholeClocks = await row(191);
    assert(Number.isSafeInteger(Number(wholeClocks.activityStartedAt)), `resumed start is whole (${wholeClocks.activityStartedAt})`);
    assert(Number.isSafeInteger(Number(wholeClocks.nextResolveAt)), `resumed due is whole (${wholeClocks.nextResolveAt})`);
    assert(Number.isSafeInteger(stats(wholeClocks).restUntil), `resumed rest deadline is whole (${stats(wholeClocks).restUntil})`);

    for (const id of [201, 202, 203]) await seed(id, 'grouped', { role: 'dps', leaderId: 201, backgroundPartyId: 'const-group' });
    await query("UPDATE bot_life_state SET partyId='const-group' WHERE characterId IN (201,202,203)");
    await query(`INSERT INTO bot_background_parties(partyId,leaderId,memberIdsJson,status,nextResolveAt,statsJson)
        VALUES ('const-group',201,'[201,202,203]','active',?,'{"objective":{"kind":"raid","npcId":123}}')`, [at + 60000.5]);
    paused = await DB.pauseConstPartyActivity({ characterId: 201, playerId: 9001 });
    assert.equal(paused.rows.length, 3); assert.equal(paused.party.status, 'const_paused');
    assert(paused.rows.every(row => row.phase === 'hot' && !row.partyId));
    assert.equal((await DB.pauseConstPartyActivity({ characterId: 202, playerId: 9001 })).ok, true);
    result = await DB.releaseConstPartyActivity({ characterId: 201, playerId: 9001 });
    assert(result.waiting, 'the original group stays paused while another member is with a player');
    result = await DB.releaseConstPartyActivity({ characterId: 202, playerId: 9001 });
    assert.equal(result.party.status, 'active'); assert.equal(JSON.parse(result.party.statsJson).objective.npcId, 123);
    assert(Number.isSafeInteger(Number(result.party.nextResolveAt)), `resumed party due is whole (${result.party.nextResolveAt})`);
    assert(result.rows.every(row => row.partyId === 'const-group' && row.phase === 'cold' && row.activity === 'grouped'));
    assert.equal((await DB.pauseConstPartyActivity({ characterId: 201, playerId: 9001 })).ok, true);
    assert.equal(await DB.recoverConstPartyActivities(), 3, 'a restart also resumes unselected paused group members');
    assert.equal((await row(203)).partyId, 'const-group');

    for (const id of [211, 212]) await seed(id, 'hunting', { leaderId: 9001,
        playerPartyTakeover: { partyId: 'inherited-const', playerId: 9001 } });
    await query(`INSERT INTO bot_background_parties(partyId,leaderId,memberIdsJson,status,statsJson)
        VALUES ('inherited-const',211,'[211,212]','player_taken_over','{"playerTakeover":{"playerId":9001}}')`);
    paused = await DB.pauseConstPartyActivity({ characterId: 211, playerId: 9001 });
    assert.equal(paused.party.status, 'const_paused'); assert.equal(paused.rows.length, 2);
    assert(paused.rows.every(row => !stats(row).playerPartyTakeover), 'const ownership replaces the previous player takeover');
    result = await DB.releaseConstPartyActivity({ characterId: 211, playerId: 9001 });
    assert.equal(result.party.status, 'active');
    assert(result.rows.every(row => row.partyId === 'inherited-const' && !stats(row).playerPartyTakeover));

    await seed(301, 'merchant', { marketStore: { storeType: 1, items: [{ selfId: 1867, count: 5, price: 100 }] } });
    await DB.pauseConstPartyActivity({ characterId: 301, playerId: 9001 });
    // A later actor save must preserve the native pause marker.
    Life.acceptLifecycleRow(await row(301));
    const beforeSave = Life.cachedState(301);
    await Life.upsertState({ ...beforeSave, stats: { ...beforeSave.stats, constPartySession: undefined } }, 'test_late_actor');
    assert(stats(await row(301)).constPartySession);
    const staleMarker = { ...beforeSave.stats.constPartySession,
        saved: { ...beforeSave.stats.constPartySession.saved, fields: { travel: { arrivalAt: 1 } } } };
    await Life.upsertState({ ...beforeSave, stats: { ...beforeSave.stats, constPartySession: staleMarker } }, 'test_stale_activity');
    assert.equal(stats(await row(301)).constPartySession.saved.fields.travel, undefined,
        'a stale actor cannot merge a previous activity into the native checkpoint');
    await DB.close(); DB.init();
    assert.equal(await DB.recoverConstPartyActivities(), 1);
    restored = await row(301);
    assert.equal(restored.activity, 'merchant'); assert.equal(restored.phase, 'cold');
    assert.equal(stats(restored).marketStore.items[0].selfId, 1867);

    // Exercise the public friend invite, native pause and detach/resume path.
    await seed(401, 'shopping', { equipmentPlan: { strategy: 'market' }, supplyErrand: { workflowId: 'paused-supply' } });
    const player = { actor: actor(9001), dataSendToMe() {} };
    const bot = { actor: actor(401), accountId: 'bot_const_401', plan: 'shopping', supplyErrandPhase: 'cold', coldLifeState: Life.cachedState(401) };
    patch(Manager, 'sessions', [bot]);
    patch(invoke('GameServer/Bot/BotAI'), 'stop', () => {});
    patch(invoke('GameServer/Bot/BotAI'), 'init', () => {});
    patch(invoke('GameServer/Bot/BotAI'), 'wakeup', () => {});
    patch(invoke('GameServer/Bot/AI/BotPvpTactics'), 'stop', () => {});
    patch(Life, 'markHot', async session => Life.cachedState(session.actor.fetchId()));
    const cancellations = [];
    patch(invoke('GameServer/AfkTrade/TradeMeetingService'), 'prepareForPlayerParty', async id => { cancellations.push(id); return true; });
    patch(invoke('GameServer/Bot/Population/ColdSimulationCoordinator'), 'fenceBot', async () => ({ ok: true }));
    patch(invoke('GameServer/Bot/Population/ColdSimulationCoordinator'), 'notifyState', () => {});
    patch(World, 'removeUser', () => {});
    patch(World, 'user', { sessions: [player] });
    patch(invoke('GameServer/Bot/AI/BotEventJournal'), 'record', async () => {});
    patch(invoke('GameServer/World/Generics/NpcBypasses/CompanionControl'), 'render', () => {});
    let invitations = 0;
    patch(World, 'inviteBotByName', async (s, a, name, distribution, source, options) => {
        invitations++; assert(options.constParty); assert(options.capacityReservation);
        assert.equal(source, 'friend_const'); assert.equal(s, player); assert.equal(a, player.actor);
        assert.equal(Availability.evaluate(player, bot, options).available, true, 'const ignores the 58-level difference');
        bot.partyCompanion = true; bot.followPlayerSession = player; bot.plan = 'following'; return true;
    });
    assert.equal(await World.inviteFriendByName(player, player.actor, 'Const401', undefined, 'friend_const'), true);
    assert.deepEqual(cancellations, [401]); assert(Const.has(bot));
    assert.equal(bot.supplyErrandPhase, undefined, 'a suspended errand cannot veto the following AI');
    assert.equal(await World.inviteFriendByName(player, player.actor, 'Const401', undefined, 'friend_const'), true);
    assert.equal(invitations, 1, 'repeated Form does not interrupt an existing companion');
    assert.equal(Companion.clearCompanion(bot), true);
    await bot.constPartyResumePromise;
    restored = await row(401); assert.equal(restored.activity, 'shopping'); assert.equal(restored.phase, 'cold');
    assert.equal(stats(restored).equipmentPlan.strategy, 'market'); assert.equal(bot.actor, null);
    assert.equal(stats(restored).supplyErrand.workflowId, 'paused-supply');

    await seed(402, 'traveling', { travel });
    patch(World, 'inviteBotByName', originalNamedInvite);
    patch(invoke('GameServer/Bot/AI/BotPvpDefense'), 'clear', () => {});
    patch(invoke('GameServer/Bot/AI/BotSocialMemory'), 'recordEvent', async () => {});
    patch(Manager, 'botTell', () => {});
    patch(invoke('GameServer/Bot/Population/ActivationPlacement'), 'resolve', () => ({ loc: { locX: 10, locY: 20, locZ: 30 } }));
    patch(invoke('GameServer/Bot/Population/PopulationService'), 'requestActivation', (state, reason, options) => {
        assert(options.constParty, 'the const priority reaches cold activation');
        return invoke('GameServer/Bot/Population/HotActivation').activate(state, reason, options);
    });
    patch(Manager, 'loadAndSpawnBot', async (accountId, options) => {
        const session = { actor: actor(options.coldLifeState.characterId), accountId, plan: options.plan, coldLifeState: options.coldLifeState };
        Manager.sessions.push(session); return session;
    });
    patch(Companion, 'attach', (leader, session) => {
        session.followPlayerSession = leader; session.partyCompanion = true; session.plan = 'following'; return true;
    });
    assert.equal(await World.inviteFriendByName(player, player.actor, 'Const402', undefined, 'friend_const'), true,
        'a paused cold traveller spawns and joins through the real remote invitation path');
    const remote = Manager.findSessionById(402);
    assert(Companion.isActiveCompanion(remote, player));
    assert.equal(Companion.clearCompanion(remote), true); await remote.constPartyResumePromise;
    assert.equal((await row(402)).activity, 'traveling');

    for (const id of [501, 502]) await seed(id, 'grouped', { leaderId: 501, backgroundPartyId: 'hot-const-group' });
    await query("UPDATE bot_life_state SET phase='hot',partyId='hot-const-group' WHERE characterId IN (501,502)");
    await query("INSERT INTO bot_background_parties(partyId,leaderId,memberIdsJson,status) VALUES ('hot-const-group',501,'[501,502]','hot')");
    for (const id of [501, 502]) Life.acceptLifecycleRow(await row(id));
    const groupSessions = [501, 502].map(id => ({ actor: actor(id), accountId: `bot_const_${id}`,
        plan: 'hunting', hotBackgroundPartyId: 'hot-const-group', coldLifeState: Life.cachedState(id) }));
    Manager.sessions = groupSessions.slice();
    assert.equal(await World.inviteFriendByName(player, player.actor, 'Const501', undefined, 'friend_const'), true);
    assert.equal(groupSessions[1].actor, null, 'paused peers leave the world so NPCs cannot keep attacking them');
    assert.equal(Companion.clearCompanion(groupSessions[0]), true); await groupSessions[0].constPartyResumePromise;
    assert.equal((await row(501)).partyId, 'hot-const-group'); assert.equal((await row(502)).partyId, 'hot-const-group');

    const outsider = { actor: actor(999), accountId: 'bot_const_999', followPlayerSession: player, partyCompanion: true };
    Manager.sessions = [outsider];
    await Const.prepareFormation(player, player.actor, [{ characterId: 501 }]);
    assert.equal(outsider.partyCompanion, false, 'Form frees slots held by companions outside the chosen const roster');

    await seed(601, 'shopping', { equipmentPlan: { strategy: 'market' } });
    Manager.sessions = [];
    patch(World, 'inviteBotByName', async () => false);
    assert.equal(await World.inviteFriendByName(player, player.actor, 'Const601', undefined, 'friend_const'), false);
    assert.equal((await row(601)).activity, 'shopping', 'a failed summon resumes the activity immediately');
    assert.equal(stats(await row(601)).constPartySession, undefined);

    await seed(602, 'resting', { restUntil: Date.now() + 60000 });
    const originalActor = player.actor;
    patch(invoke('GameServer/AfkTrade/TradeMeetingService'), 'prepareForPlayerParty', async () => {
        player.actor = actor(9002); return true;
    });
    assert.equal(await World.inviteFriendByName(player, originalActor, 'Const602', undefined, 'friend_const'), false);
    assert.equal((await row(602)).activity, 'resting', 'a character switch cannot leave a bot suspended');
    player.actor = originalActor;
    patch(invoke('GameServer/AfkTrade/TradeMeetingService'), 'prepareForPlayerParty', async () => true);

    await seed(701, 'hunting');
    const fullParty = Array.from({ length: 8 }, (_, index) => ({ actor: actor(701 + index),
        accountId: `bot_const_${701 + index}`, followPlayerSession: player, partyCompanion: true, plan: 'following' }));
    fullParty[0].coldLifeState = Life.cachedState(701); Manager.sessions = fullParty;
    assert.equal(Companion.hasCapacity(player), false);
    assert.equal(await World.inviteFriendByName(player, player.actor, 'Const701', undefined, 'friend_const'), true,
        'an existing companion can become a const member when all eight slots are occupied');
    assert(Const.has(fullParty[0]));
    Companion.clearCompanion(fullParty[0], { rebuildWindow: false, refreshPanel: false });
    await fullParty[0].constPartyResumePromise;

    for (const id of [801, 802]) await seed(id, 'grouped', { leaderId: 801, backgroundPartyId: 'concurrent-const' });
    await query("UPDATE bot_life_state SET phase='hot',partyId='concurrent-const' WHERE characterId IN (801,802)");
    await query("INSERT INTO bot_background_parties(partyId,leaderId,memberIdsJson,status) VALUES ('concurrent-const',801,'[801,802]','hot')");
    for (const id of [801, 802]) Life.acceptLifecycleRow(await row(id));
    Manager.sessions = [801, 802].map(id => ({ actor: actor(id), accountId: `bot_const_${id}`,
        plan: 'hunting', hotBackgroundPartyId: 'concurrent-const', coldLifeState: Life.cachedState(id) }));
    World.inviteBotByName = originalNamedInvite;
    assert.deepEqual(await Promise.all([801, 802].map(id => World.inviteFriendByName(player, player.actor, `Const${id}`, undefined, 'friend_const'))), [true, true]);
    const concurrent = [801, 802].map(id => Manager.findSessionById(id));
    assert(concurrent.every(session => session.partyCompanion && !session.constActivityPaused),
        'calling another member cannot stop a friend who already joined the const');
    for (const session of concurrent) Companion.clearCompanion(session, { rebuildWindow: false, refreshPanel: false });
    await Promise.all(concurrent.map(session => session.constPartyResumePromise));
    assert.equal((await row(801)).partyId, 'concurrent-const'); assert.equal((await row(802)).partyId, 'concurrent-const');

    await seed(901, 'shopping'); await seed(902, 'merchant');
    await query(`INSERT INTO board_trade_meetings(token,terms,actorA,actorB,seqA,seqB,town,locX,locY,locZ,routeA,routeB)
        VALUES ('const-custody','{}',901,902,1,1,'Giran',0,0,0,'{}','{}')`);
    assert.equal((await DB.pauseConstPartyActivity({ characterId: 901, playerId: 9001 })).reason, 'trade_cancellation_pending');
    assert.equal(stats(await row(901)).constPartySession, undefined, 'uncancelled custody cannot be hidden by party ownership');
    await query("DELETE FROM board_trade_meetings WHERE token='const-custody'");

    await seed(1001, 'hunting'); await seed(9002);
    await query("INSERT INTO bot_friendships(playerId,botId,status,createdAt,updatedAt) VALUES (9002,1001,'accepted',1,1)");
    paused = await DB.pauseConstPartyActivity({ characterId: 1001, playerId: 9001 });
    const transfer = { actor: actor(1001), accountId: 'bot_const_1001', plan: 'following',
        coldLifeState: Life.acceptLifecycleRow(paused.rows[0]), partyCompanion: true, followPlayerSession: player };
    Manager.sessions = [transfer];
    patch(invoke('GameServer/AfkTrade/TradeMeetingService'), 'prepareForPlayerParty', async () => false);
    const newcomer = { actor: actor(9002), dataSendToMe() {} };
    await assert.rejects(World.inviteFriendByName(newcomer, newcomer.actor, 'Const1001', undefined, 'friend_const'), /trade_cancellation_failed/);
    restored = await row(1001);
    assert.equal(restored.phase, 'cold'); assert.equal(restored.activity, 'hunting');
    assert.equal(stats(restored).constPartySession, undefined, 'a failed transfer releases the old checkpoint too');
    assert.equal(transfer.actor, null, 'a bot displaced by a failed transfer cannot remain frozen in the world');
    patch(invoke('GameServer/AfkTrade/TradeMeetingService'), 'prepareForPlayerParty', async () => true);

    for (const id of [1101, 1102]) await seed(id, 'hunting', { leaderId: 9001,
        playerPartyTakeover: { partyId: 'forming-inherited', playerId: 9001 } });
    await query(`INSERT INTO bot_background_parties(partyId,leaderId,memberIdsJson,status,statsJson)
        VALUES ('forming-inherited',1101,'[1101,1102]','player_taken_over','{"playerTakeover":{"playerId":9001}}')`);
    for (const id of [1101, 1102]) Life.acceptLifecycleRow(await row(id));
    const inherited = [1101, 1102].map(id => ({ actor: actor(id), accountId: `bot_const_${id}`,
        plan: 'following', partyCompanion: true, followPlayerSession: player, coldLifeState: Life.cachedState(id) }));
    Manager.sessions = inherited.slice();
    await Const.prepareFormation(player, player.actor, [{ characterId: 1101 }]);
    assert.equal(inherited[1].actor, null, 'Form preserves the whole inherited roster before removing unselected companions');
    assert.equal(await World.inviteFriendByName(player, player.actor, 'Const1101', undefined, 'friend_const'), true);
    assert.equal(inherited[0].constActivityPaused, false);
    Companion.clearCompanion(inherited[0], { rebuildWindow: false, refreshPanel: false }); await inherited[0].constPartyResumePromise;
    assert.equal((await row(1101)).partyId, 'forming-inherited'); assert.equal((await row(1102)).partyId, 'forming-inherited');

    for (const id of [1201, 1202]) await seed(id, 'hunting', { leaderId: 9001,
        playerPartyTakeover: { partyId: 'cancelled-inherited', playerId: 9001 } });
    await query(`INSERT INTO bot_background_parties(partyId,leaderId,memberIdsJson,status,statsJson)
        VALUES ('cancelled-inherited',1201,'[1201,1202]','player_taken_over','{"playerTakeover":{"playerId":9001}}')`);
    for (const id of [1201, 1202]) Life.acceptLifecycleRow(await row(id));
    const cancelled = [1201, 1202].map(id => ({ actor: actor(id), accountId: `bot_const_${id}`,
        plan: 'following', partyCompanion: true, followPlayerSession: player, coldLifeState: Life.cachedState(id) }));
    Manager.sessions = cancelled.slice();
    const nextCharacterCompanion = { actor: actor(1301), accountId: 'bot_const_1301', plan: 'following',
        partyCompanion: true, followPlayerSession: player };
    const pauseBeforeSwitch = DB.pauseConstPartyActivity;
    patch(DB, 'pauseConstPartyActivity', async request => {
        const result = await pauseBeforeSwitch.call(DB, request);
        player.actor = actor(9002);
        for (const session of cancelled) { session.partyCompanion = false; session.followPlayerSession = null; }
        Manager.sessions.push(nextCharacterCompanion);
        return result;
    });
    await Const.prepareFormation(player, originalActor, [{ characterId: 1201 }]);
    assert.equal((await row(1201)).phase, 'cold'); assert.equal((await row(1201)).partyId, 'cancelled-inherited');
    assert.equal(stats(await row(1201)).constPartySession, undefined, 'cancelled pre-formation cannot leave an active checkpoint without a leader');
    assert(nextCharacterCompanion.partyCompanion && nextCharacterCompanion.followPlayerSession === player,
        'a stale Form cannot detach companions belonging to the newly selected character');
    player.actor = originalActor;

    DB.pauseConstPartyActivity = pauseBeforeSwitch;
    await query("UPDATE bot_background_parties SET status='player_taken_over',statsJson=? WHERE partyId='cancelled-inherited'",
        [JSON.stringify({ playerTakeover: { playerId: 9001 } })]);
    await query("UPDATE bot_life_state SET partyId=NULL,phase='hot',activity='hunting',statsJson=? WHERE characterId IN (1201,1202)",
        [JSON.stringify({ leaderId: 9001, playerPartyTakeover: { partyId: 'cancelled-inherited', playerId: 9001 } })]);
    for (const id of [1201, 1202]) Life.acceptLifecycleRow(await row(id));
    const laterCancelled = [1201, 1202].map(id => ({ actor: actor(id), accountId: `bot_const_${id}`,
        plan: 'following', partyCompanion: true, followPlayerSession: player, coldLifeState: Life.cachedState(id) }));
    Manager.sessions = laterCancelled;
    player.nativeFriendsVersion = 1; player.nativeFriendsOpen = true; player.botFriendsView = { mode: 'friends', page: 0 };
    patch(Friends, 'selected', async () => [{ characterId: 1201, name: 'Const1201' }]);
    const prepareBeforeSwitch = Const.prepareFormation;
    patch(Const, 'prepareFormation', async (...args) => {
        const ticket = await prepareBeforeSwitch(...args);
        player.actor = actor(9002);
        for (const session of laterCancelled) { session.partyCompanion = false; session.followPlayerSession = null; }
        return ticket;
    });
    await invoke('GameServer/World/Generics/NpcBypasses/NativeFriends')(player, ['native-friends', 'form']);
    assert.equal((await row(1201)).phase, 'cold');
    assert.equal(stats(await row(1201)).constPartySession, undefined, 'the UI also rolls back cancellation after preparation returned');
    assert.equal(player.nativeFriendsBusy, false);
    console.log('Const party: trust six, durable pause, worker fence, travel clocks, progress preservation, whole-group resume, restart, trade cancellation and detach passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    saved.reverse().forEach(restore => restore()); await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
});
