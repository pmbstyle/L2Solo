const assert = require('node:assert/strict');
const fs = require('node:fs');
const fixture = require('./helpers/isolatedSocialDatabase')('l2-clan-leader-invite');
require('./helpers/databaseIsolation');
require('../src/Global');
fixture.assertConfigured(options.default);
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Clans = invoke('GameServer/Clan/ClanService'), Manager = invoke('GameServer/Bot/BotManager');
const World = invoke('GameServer/World/World'), Party = invoke('GameServer/Bot/AI/PartyCompanionService');
const Availability = invoke('GameServer/Bot/AI/BotAvailability');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const AI = invoke('GameServer/Bot/BotAI');
const restores = [];
function patch(object, key, value) { const old = object[key]; restores.push(() => { object[key] = old; }); object[key] = value; }
const query = (sql, params = []) => DB.execute([sql, params]);
const row = async id => (await query('SELECT * FROM bot_life_state WHERE characterId=?', [id]))[0];
const stats = row => JSON.parse(row.statsJson || '{}');
let clan = { id: 77, leaderId: 9001, members: [] };
const regenerated = [];
async function seed(id, activity = 'hunting', phase = 'cold', extra = {}) {
    await query('INSERT INTO accounts(username,password) VALUES (?,?)', [`bot_clan_${id}`, 'test']);
    await query(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,hp,mp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
        VALUES (?,?,?,0,0,20,100,100,100,100,0,0,0,0,10,20,30,77)`, [id, `bot_clan_${id}`, `ClanBot${id}`]);
    if (id >= 9000) return;
    clan.members.push({ id });
    const at = Date.now();
    await query(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,
        locX,locY,locZ,hp,maxHp,mp,maxMp,nextResolveAt,updatedAt,statsJson,inventorySummary)
        VALUES (?,?,?,20,?,?,10,20,30,100,100,100,100,?,?,?,'{}')`,
    [id, `bot_clan_${id}`, `ClanBot${id}`, phase, activity, at + 60000, at, JSON.stringify(extra)]);
    Life.acceptLifecycleRow(await row(id));
}
async function group(partyId, ids, phase = 'cold', partyStats = {}) {
    for (const id of ids) await seed(id, 'grouped', phase, { backgroundPartyId: partyId, leaderId: ids[0], role: 'dps' });
    await query(`UPDATE bot_life_state SET partyId=? WHERE characterId IN (${ids.map(() => '?').join(',')})`, [partyId, ...ids]);
    await query(`INSERT INTO bot_background_parties(partyId,leaderId,memberIdsJson,status,nextResolveAt,statsJson)
        VALUES (?,?,?,?,?,?)`, [partyId, ids[0], JSON.stringify(ids), phase === 'hot' ? 'hot' : 'active', Date.now() + 60000, JSON.stringify(partyStats)]);
    for (const id of ids) Life.acceptLifecycleRow(await row(id));
    Parties.acceptRow((await query('SELECT * FROM bot_background_parties WHERE partyId=?', [partyId]))[0]);
}
function actor(id, level = 20) {
    return { fetchId: () => id, fetchName: () => `ClanBot${id}`, fetchLevel: () => level,
        fetchClanId: () => 77, fetchIsOnline: () => true, fetchClassId: () => 0,
        fetchLocX: () => 10, fetchLocY: () => 20, fetchLocZ: () => 30,
        fetchHp: () => 100, fetchMaxHp: () => 100, setHp() {}, fetchMp: () => 100, fetchMaxMp: () => 100, setMp() {},
        fetchCp: () => 100, fetchMaxCp: () => 100,
        refreshVitalsRegeneration: () => regenerated.push(id),
        isDead: () => false, unselect() {}, attack: { abortCast() {}, clearTimers() {}, resetQueuedEvent() {} },
        state: { setHits() {}, setCasts() {}, fetchSeated: () => false }, automation: { abortAll() {}, stopReplenish() {} } };
}
function body(id) {
    const state = Life.cachedState(id);
    const session = { actor: actor(id), accountId: `bot_clan_${id}`, plan: state.activity,
        coldLifeState: state, hotBackgroundPartyId: state.party?.partyId, aiActive: true,
        dataSendToMe() {}, dataSendToOthers() {} };
    session.actor.session = session;
    Manager.sessions.push(session);
    return session;
}
async function main() {
    DB.init(); await Life.init();
    await seed(9001); await seed(9002);
    await query("INSERT INTO clans(id,name,level,leaderId) VALUES (77,'ClanPriority',3,9001)");
    patch(Clans, 'findById', id => id === 77 ? clan : null);
    patch(Manager, 'sessions', []);
    patch(Manager, 'botTell', () => {});
    patch(invoke('GameServer/Bot/AI/BotSocialMemory'), 'getSnapshot', () => ({ trust: -20 }));
    patch(invoke('GameServer/Bot/AI/BotSocialMemory'), 'peekSnapshot', () => ({ trust: -20 }));
    patch(invoke('GameServer/Bot/AI/BotSocialMemory'), 'recordEvent', async () => {});
    patch(invoke('GameServer/Social/InteractionMemoryRuntime'), 'assess', () => ({ ready: false }));
    patch(invoke('GameServer/Social/InteractionMemoryRuntime'), 'ensureMany', async () => { throw Error('clan leader must not wait for relationships'); });
    patch(AI, 'stop', session => { session.aiActive = false; });
    patch(AI, 'wakeup', () => {});
    patch(invoke('GameServer/Bot/AI/BotPvpTactics'), 'stop', () => {});
    patch(invoke('GameServer/Bot/AI/BotSupportPlanner'), 'cancelSupportCast', () => {});
    patch(invoke('GameServer/Bot/BotTradeService'), 'cleanup', () => {});
    patch(invoke('GameServer/Bot/AI/BotEventJournal'), 'record', async () => {});
    patch(invoke('GameServer/World/Generics/NpcBypasses/CompanionControl'), 'render', () => {});
    patch(Life, 'markHot', async session => Life.cachedState(session.actor.fetchId()));
    patch(Coordinator, 'fenceBot', async () => ({ ok: true }));
    patch(Coordinator, 'releaseFence', () => {});
    const arrivals = [];
    patch(Party, 'bringToLeader', (player, session) => { arrivals.push([player, session]); return true; });
    patch(invoke('GameServer/Bot/Population/ActivationPlacement'), 'resolve', () => ({ loc: { locX: 10, locY: 20, locZ: 30 } }));
    let spawns = 0;
    patch(Manager, 'loadAndSpawnBot', async (_account, data) => {
        spawns++; assert.equal(data.coldLifeState.party?.partyId, null);
        return body(data.coldLifeState.characterId);
    });
    const player = { actor: actor(9001, 78), dataSendToMe() {} };
    const otherPlayer = { actor: actor(9002), dataSendToMe() {} };

    // The authority applies to exactly the bot's own clan leader, including
    // unloaded/hostile relationships and levels outside the normal range.
    await group('cold-priority', [101, 102, 103]);
    assert.equal(Availability.evaluateState(player, Life.cachedState(101)).available, true);
    assert.equal(Availability.evaluateState(otherPlayer, Life.cachedState(101)).reason, 'already_grouped');
    const before = await row(101);
    assert.equal((await DB.claimBotForClanLeader({ characterId: 101, playerId: 9002, isCurrent: () => true })).ok, false);
    assert.equal((await row(101)).simulationRevision, before.simulationRevision);
    assert.equal(await World.inviteBotByName(player, player.actor, 'ClanBot101', 1), true);
    assert.equal(spawns, 1, 'a cold member is activated individually after the native claim');
    assert(Party.isActiveCompanion(Manager.findSessionById(101), player));
    let remaining = (await query("SELECT * FROM bot_background_parties WHERE partyId='cold-priority'"))[0];
    assert.deepEqual(JSON.parse(remaining.memberIdsJson), [102, 103]);
    assert.equal(remaining.leaderId, 102);
    assert.equal((await row(102)).partyId, 'cold-priority');
    assert.equal(stats(await row(102)).leaderId, 102);
    assert.equal((await row(101)).partyId, null);
    assert.equal((await DB.handoffColdSimulationToMain({ characterId: 101, expectedRevision: before.simulationRevision })).reason, 'stale_revision');

    // Native C4 target invitations use the same hot path. Losing a member
    // below minimum dissolves the old party and releases its remaining row.
    await group('hot-priority', [201, 202], 'hot');
    const hot = body(201), formerMember = body(202);
    assert.equal(Availability.evaluate(player, hot).available, true);
    assert.equal(Availability.evaluate(player, { ...hot, staticService: true }).reason, 'merchant_duty');
    assert.equal(await World.inviteBotCompanion(player, player.actor, hot, 1), true);
    assert(Party.isActiveCompanion(hot, player));
    assert.equal(formerMember.hotBackgroundPartyId, null);
    assert.equal(formerMember.coldLifeState.party.partyId, null);
    assert.equal((await row(202)).partyId, null);

    for (const activity of ['resting', 'shopping', 'traveling', 'merchant', 'pk_hunting', 'hunting']) {
        const id = 300 + spawns;
        await seed(id, activity, 'cold', { travel: { arrivalAt: Date.now() + 60000 },
            supplyErrand: { active: true }, coldCompetition: { wait: { combat: true, until: Date.now() + 60000 } } });
        assert.equal(await World.inviteBotByName(player, player.actor, `ClanBot${id}`, 1), true, `${activity} never delays the clan leader`);
        assert.equal(stats(await row(id)).travel, undefined);
        assert.equal(stats(await row(id)).supplyErrand, undefined);
    }

    // Full player parties must not disrupt the bot's previous work.
    await seed(401, 'resting');
    const fullBefore = await row(401);
    assert.equal(await World.inviteBotByName(player, player.actor, 'ClanBot401', 1), false);
    assert.equal((await row(401)).simulationRevision, fullBefore.simulationRevision);
    const recalled = Manager.findSessionById(201);
    recalled.plan = 'shopping'; recalled.companionShopping = { kind: 'player_resource_purchase' };
    recalled.supplyErrandPhase = 'cold'; recalled.townEscape = { token: Symbol('old-escape') };
    recalled.pendingTownTrip = { requestedAt: Date.now() };
    assert.equal(await World.inviteBotCompanion(player, player.actor, recalled, 1), true,
        'recalling an existing companion needs no extra party slot');
    assert.equal(recalled.plan, 'following');
    assert.equal(recalled.companionShopping, null);
    assert.equal(recalled.supplyErrandPhase, null);
    assert.equal(recalled.townEscape, undefined, 'the previous escape callback can no longer move the bot away');
    assert.equal(Party.membersForLeader(player).length, 8);
    Party.detach(player, Manager.findSessionById(101), { rebuildWindow: false, refreshPanel: false });

    // A bot immediately switches away from another human's party.
    await seed(501, 'following', 'hot');
    const borrowed = body(501);
    borrowed.partyCompanion = true; borrowed.followPlayerSession = otherPlayer;
    assert.equal(await World.inviteBotCompanion(player, player.actor, borrowed, 1), true);
    assert.equal(borrowed.followPlayerSession, player);
    assert.equal(Party.membersForLeader(otherPlayer).length, 0);
    Party.detach(player, borrowed, { rebuildWindow: false, refreshPanel: false });

    // The actor is rechecked after a fence, before the native transaction.
    await seed(601, 'resting', 'hot'); body(601);
    const actorBefore = player.actor, savedBefore = await row(601);
    patch(Coordinator, 'fenceBot', async () => { player.actor = actor(9002); return { ok: true }; });
    assert.equal(await World.inviteBotByName(player, actorBefore, 'ClanBot601', 1), false);
    assert.equal((await row(601)).simulationRevision, savedBefore.simulationRevision);
    assert(regenerated.includes(601), 'a cancelled hot invitation restores regeneration for the bot left resting');
    player.actor = actorBefore;
    patch(Coordinator, 'fenceBot', async () => ({ ok: true }));

    // A fixed raid/military roster is cancelled rather than left with stale
    // admission proof or an active operation reservation for the summoned bot.
    await group('raid-priority', [701, 702, 703], 'cold', { objective: { kind: 'raid' }, raidAdmission: { key: 'old' } });
    await query(`INSERT INTO clan_operations(id,clanId,operationKey,operationType,leaderId,memberIdsJson,status)
        VALUES (1,77,'priority-operation','farm',701,'[701,702,703]','active')`);
    await query("INSERT INTO clan_operation_members(operationId,clanId,characterId) VALUES (1,77,701)");
    const claim = await DB.claimBotForClanLeader({ characterId: 701, playerId: 9001, isCurrent: () => true });
    assert.equal(claim.ok, true);
    assert.equal(claim.party.status, 'dissolved');
    assert(claim.rows.every(row => !row.partyId));
    assert.equal((await query('SELECT status FROM clan_operations WHERE id=1'))[0].status, 'cancelled');
    assert.equal((await query('SELECT status FROM clan_operation_members WHERE operationId=1'))[0].status, 'released');

    // Native party escrow is refunded once even if the payer is already hot.
    await group('funded-priority', [801, 802, 803], 'hot', { agreement: { mode: 'turn',
        help: { payerId: 801, helperIds: [802, 803], fee: 1000, remaining: 1000, paid: 0,
            delivered: 0, baselineAmount: 0, itemId: 1867, count: 10, status: 'funded' } } });
    await DB.setItem(801, { selfId: 57, name: 'Adena', amount: 100, slot: 0 });
    const cash = (await DB.fetchItems(801)).find(item => item.selfId === 57);
    invoke('GameServer/Persistence/CharacterWriteQueue').itemAmount(801, cash.id, 150);
    const funded = await DB.claimBotForClanLeader({ characterId: 801, playerId: 9001, isCurrent: () => true });
    assert.equal(funded.ok, true);
    assert.equal(funded.rows.find(row => row.characterId === 801).adena, 1150);
    assert.equal(stats(funded.party).agreement.help.status, 'cancelled');
    assert.equal(funded.inventories.length, 1);
    assert.equal((await DB.fetchItems(801)).find(item => item.selfId === 57).amount, 1150,
        'a buffered actor balance cannot overwrite the native escrow refund');
    assert.equal((await DB.claimBotForClanLeader({ characterId: 801, playerId: 9001, isCurrent: () => true })).rows[0].adena, 1150);

    // Extracting a member from a paused const must not strand the inactive
    // remainder hot, or leave another player's active checkpoint unrestorable.
    for (const [partyId, ids, bothActive] of [['paused-one', [901, 902], false], ['paused-two', [911, 912], true]]) {
        await group(partyId, ids);
        for (const id of ids) await query("INSERT INTO bot_friendships(playerId,botId,status,createdAt,updatedAt) VALUES (9002,?,'accepted',?,?)", [id, Date.now(), Date.now()]);
        assert.equal((await DB.pauseConstPartyActivity({ characterId: ids[0], playerId: 9002 })).ok, true);
        if (bothActive) assert.equal((await DB.pauseConstPartyActivity({ characterId: ids[1], playerId: 9002 })).ok, true);
        const moved = await DB.claimBotForClanLeader({ characterId: ids[0], playerId: 9001, isCurrent: () => true });
        assert.equal(moved.ok, true);
        assert.equal(stats(await row(ids[0])).constPartySession, undefined);
        if (bothActive) {
            assert.equal(stats(await row(ids[1])).constPartySession.groupId, null);
            await DB.releaseConstPartyActivity({ characterId: ids[1], playerId: 9002 });
        }
        assert.equal((await row(ids[1])).phase, 'cold');
        assert.equal(stats(await row(ids[1])).constPartySession, undefined);
    }

    await group('batch-priority', [1001, 1002, 1003, 1004]);
    const batchLeader = { actor: actor(9001), dataSendToMe() {} };
    const batch = await Promise.all([1001, 1002].map(id => World.inviteBotByName(batchLeader, batchLeader.actor, `ClanBot${id}`, 1)));
    assert.deepEqual(batch, [true, true], 'concurrent invitations from one autonomous party serialize their native membership changes');
    assert.equal(Party.membersForLeader(batchLeader).length, 2);
    assert.deepEqual(JSON.parse((await query("SELECT memberIdsJson FROM bot_background_parties WHERE partyId='batch-priority'"))[0].memberIdsJson), [1003, 1004]);

    await seed(1101);
    const spawnNormally = Manager.loadAndSpawnBot;
    patch(Manager, 'loadAndSpawnBot', async () => null);
    const failedLeader = { actor: actor(9001), dataSendToMe() {} };
    assert.equal(await World.inviteBotByName(failedLeader, failedLeader.actor, 'ClanBot1101', 1), false);
    assert.equal((await row(1101)).phase, 'cold', 'a failed spawn returns its claimed row to simulation instead of leaving an invisible hot bot');
    assert.equal(Life.cachedState(1101).phase, 'cold');
    assert(Number((await row(1101)).nextResolveAt) > 0);
    patch(Manager, 'loadAndSpawnBot', spawnNormally);

    // An ambient spawn already holding the bot completes before the leader
    // takes over its newly published actor; no duplicate activation or refusal.
    await seed(1201);
    let reachedSolo, releaseSolo;
    const soloReached = new Promise(resolve => { reachedSolo = resolve; });
    const soloRelease = new Promise(resolve => { releaseSolo = resolve; });
    let firstSolo = true;
    patch(Manager, 'loadAndSpawnBot', async (account, data) => {
        if (firstSolo && data.coldLifeState.characterId === 1201) {
            firstSolo = false; reachedSolo(); await soloRelease;
        }
        return spawnNormally(account, data);
    });
    const ambient = invoke('GameServer/Bot/Population/HotActivation').activate(Life.cachedState(1201), 'near_player');
    await Promise.race([soloReached, ambient.then(result => { throw Error(`Ambient activation ended before spawn: ${JSON.stringify(result)}`); })]);
    const soloInvitation = World.inviteBotByName(failedLeader, failedLeader.actor, 'ClanBot1201', 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await row(1201)).phase, 'cold', 'the clan claim waits for the in-flight solo transition');
    releaseSolo();
    assert.equal((await ambient).ok, true);
    assert.equal(await soloInvitation, true);
    assert.equal(Manager.sessions.filter(session => session.actor?.fetchId() === 1201).length, 1);
    patch(Manager, 'loadAndSpawnBot', spawnNormally);

    const pvpAt = Date.now(), encounter = { key: 'clan-invite-pvp-race', startedAt: pvpAt, stepAt: pvpAt,
        expiresAt: pvpAt + 60000, sequence: 1,
        sides: [{ principalId: 1301, memberIds: [1301], partyId: null }, { principalId: 1302, memberIds: [1302], partyId: null }],
        roles: [[1301, 'initiator'], [1302, 'target']], seen: [], willing: [true, true] };
    await seed(1301, 'hunting', 'cold', { pvpEncounter: encounter });
    await seed(1302, 'hunting', 'cold', { pvpEncounter: encounter });
    patch(invoke('GameServer/Bot/Population/ActivationPlacement'), 'resolveGroup', states => states.map(() => ({ loc: { locX: 10, locY: 20, locZ: 30 } })));
    let reachedPvp, releasePvp;
    const pvpReached = new Promise(resolve => { reachedPvp = resolve; });
    const pvpRelease = new Promise(resolve => { releasePvp = resolve; });
    patch(Manager, 'loadAndSpawnBot', async (account, data) => {
        if (data.prepareOnly) { reachedPvp(); await pvpRelease; return null; }
        return spawnNormally(account, data);
    });
    const pvpActivation = invoke('GameServer/Bot/Population/PvpEncounterLifecycle').activate(encounter, 'near_player');
    await Promise.race([pvpReached, pvpActivation.then(result => { throw Error(`PvP activation ended before spawn: ${JSON.stringify(result)}`); })]);
    const pvpInvitation = World.inviteBotByName(failedLeader, failedLeader.actor, 'ClanBot1301', 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stats(await row(1301)).pvpEncounter.key, encounter.key, 'an in-flight encounter keeps its native rollback sources until it finishes');
    releasePvp();
    assert.equal((await pvpActivation).reason, 'encounter_spawn_failed');
    assert.equal(await pvpInvitation, true);
    assert.equal((await row(1302)).phase, 'cold', 'the other combatant must not remain invisible and hot');
    patch(Manager, 'loadAndSpawnBot', spawnNormally);

    await group('stale-raid-priority', [1401, 1402, 1403], 'cold', { objective: { kind: 'raid' } });
    await seed(1404); await seed(1405);
    await query("INSERT INTO bot_background_parties(partyId,leaderId,memberIdsJson,status,statsJson) VALUES ('new-owner',1404,'[1404,1405,1403]','active','{}')");
    await query("UPDATE bot_life_state SET partyId='new-owner' WHERE characterId=1403");
    const staleClaim = await DB.claimBotForClanLeader({ characterId: 1401, playerId: 9001, isCurrent: () => true });
    assert.equal(staleClaim.reason, 'party_membership_changed');
    assert.equal((await row(1403)).partyId, 'new-owner', 'a stale old roster cannot clear a member already owned by another party');

    await seed(1501, 'hunting', 'hot'); body(1501);
    await query("INSERT INTO bot_friendships(playerId,botId,status,createdAt,updatedAt) VALUES (9002,1501,'accepted',?,?)", [Date.now(), Date.now()]);
    let reachedConst, releaseConst;
    const constReached = new Promise(resolve => { reachedConst = resolve; });
    const constRelease = new Promise(resolve => { releaseConst = resolve; });
    const normalWorldInvite = World.inviteBotByName;
    patch(World, 'inviteBotByName', async function(...args) {
        if (args[4] === 'friend_const') { reachedConst(); await constRelease; }
        return normalWorldInvite.apply(this, args);
    });
    const oldConstInvite = invoke('GameServer/Bot/AI/ConstPartySession').invite(otherPlayer, otherPlayer.actor, Life.cachedState(1501), 1);
    await Promise.race([constReached, oldConstInvite.then(result => { throw Error(`Const invitation ended before attachment: ${result}`); })]);
    const constLeader = { actor: actor(9001), dataSendToMe() {} };
    assert.equal(await World.inviteBotByName(constLeader, constLeader.actor, 'ClanBot1501', 1), true);
    releaseConst();
    assert.equal(await oldConstInvite, false, 'a cancelled const invitation cannot reclaim a bot after the clan leader has summoned it');
    assert.equal(Manager.findSessionById(1501).followPlayerSession, constLeader);
    assert(arrivals.length >= 8);
    console.log('Clan leader invitations: authority, hot/cold activation, party handoff, activities, capacity, stale actors and raid cancellation passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    for (const session of Manager.sessions) { session.partyCompanion = false; session.followPlayerSession = null; }
    restores.reverse().forEach(restore => restore());
    await DB.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
});
