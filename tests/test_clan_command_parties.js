const assert = require('node:assert/strict');
const fs = require('node:fs');
const fixture = require('./helpers/isolatedSocialDatabase')('l2-clan-command-parties');
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
        isDead: () => false, moveTo() {}, unselect() {}, attack: { abortCast() {}, clearTimers() {}, resetQueuedEvent() {} },
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

    const Commands = invoke('GameServer/Bot/AI/ClanCommandParty');
    const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
    const { registerSessions } = require('./helpers/worldSessions');
    const messages = [];
    player.dataSendToMe = packet => messages.push(packet);
    await seed(201); await seed(202); await seed(203);
    await seed(301); await seed(401);
    assert.equal(await World.inviteBotByName(player, player.actor, 'ClanBot201'), true);
    assert.equal(Commands.handleCommand(otherPlayer, '.createparty ClanBot202'), true);
    assert.equal(otherPlayer.commandParties, undefined, 'a clan member cannot command the clan leader bot roster');
    assert.equal(Commands.handleCommand(player, '.createparty ClanBot202'), true);
    const first = player.commandParties.get(1);
    await first.pending;
    assert.equal(first.active, true);
    assert.equal(first.owner.actor.fetchId(), 202);
    assert.equal(first.owner.followPlayerSession, first.owner, 'the bot leader remains a member of its own independent party');
    assert.equal(Commands.handleCommand(player, '.invite-p1 ClanBot203'), true);
    await first.pending;
    assert.deepEqual(Commands.roster(first).map(s => s.actor.fetchId()), [202, 203]);
    assert.equal(Party.membersForLeader(player).length, 1, 'extra parties do not occupy the main party slots');
    assert.equal(Commands.handleCommand(player, '.createparty ClanBot301'), true);
    const second = player.commandParties.get(2); await second.pending;
    assert.equal(Commands.handleCommand(player, '.createparty ClanBot401'), true);
    const third = player.commandParties.get(3); await third.pending;
    registerSessions([player, ...Manager.sessions]);
    assert.deepEqual(Awareness.partySessions(first.owner).map(s => s.actor.fetchId()), [202, 203]);
    assert.equal(Awareness.combatSessions(first.owner).length, 6, 'combat sees the main party and all three additional parties');
    assert.equal(new Set(Awareness.combatActors(first.owner)).size, 6, 'the real leader body is never duplicated');
    const threat = { fetchId: () => 99001, fetchSelfId: () => 1, fetchDestId: () => first.owner.actor.fetchId(),
        fetchAttackable: () => true, isDead: () => false, fetchStateAttack: () => true,
        fetchLocX: () => 10, fetchLocY: () => 20, fetchLocZ: () => 30, state: { fetchCombats: () => true } };
    patch(World, 'npc', { spawns: [threat] });
    patch(World, 'fetchNpcsInRadius', () => [threat]);
    assert.equal(Awareness.findThreatTargetingParty(player)?.actor, threat, 'the main party sees a mob attacking an additional party');
    assert.equal(Awareness.findThreatTargetingParty(second.owner)?.actor, threat, 'another additional party sees the same shared threat');
    const originalSelection = player.actor.fetchDestId;
    player.actor.fetchDestId = () => threat.fetchId();
    assert.equal(Awareness.leaderCombatTargetId(second.owner), threat.fetchId(), 'additional parties assist the player target rather than their bot leader selection');
    if (originalSelection) player.actor.fetchDestId = originalSelection; else delete player.actor.fetchDestId;
    restores.pop()(); restores.pop()();
    Party.syncClientDistribution(player, 4);
    assert.equal(Party.distributionForLeader(first.owner), 4);
    assert.equal(Party.distributionForLeader(second.owner), 4);
    Party.updateSettings(player, { lootPickupEnabled: false });
    assert(Commands.roster(first).every(s => Party.canPickupLoot(s) === false));
    assert.equal(Party.canPickupLoot(second.owner), false, 'the additional party leader inherits the global pickup switch too');
    Party.updateSettings(player, { lootPickupEnabled: true });
    assert(Commands.roster(first).every(s => Party.canPickupLoot(s)));
    const mainCompanion = Manager.findSessionById(201);
    for (const selector of ['main', 'all']) {
        mainCompanion.plan = 'getting_buffed';
        mainCompanion.botStay = true;
        mainCompanion.stayLocation = { locX: 100, locY: 200, locZ: 30 };
        mainCompanion.resumeAfterBuff = { plan: 'following', partyCompanion: true, followPlayerSession: player,
            botStay: true, stayLocation: mainCompanion.stayLocation,
            returnMode: 'teleport', returnTeleportStartedAt: Date.now() - 2000 };
        mainCompanion.resumeAfterShopping = { plan: 'following', botStay: true, stayLocation: mainCompanion.stayLocation };
        Commands.handleCommand(player, `.${selector} follow`);
        assert.equal(mainCompanion.resumeAfterShopping.botStay, false, `${selector} Follow clears a deferred shopping Hold too`);
        patch(invoke('GameServer/Bot/AI/HotTownRebuff'), 'tripGuide', () => null);
        patch(invoke('GameServer/Bot/AI/PartyCombatState'), 'isActive', () => false);
        invoke('GameServer/Bot/AI/States/GettingBuffedState').tick(mainCompanion, mainCompanion.actor, {}, AI);
        restores.pop()(); restores.pop()();
        assert.equal(mainCompanion.botStay, false, `${selector} Follow survives the real town return`);
        assert.equal(mainCompanion.stayLocation, null);
        delete mainCompanion.resumeAfterShopping;
    }
    Commands.handleCommand(player, '.p3 hold');
    await seed(402);
    Commands.handleCommand(player, '.invite-p3 ClanBot402'); await third.pending;
    const heldRecruit = Manager.findSessionById(402);
    assert.equal(heldRecruit.botStay, true, 'a new recruit inherits the party Hold order');
    assert.deepEqual(heldRecruit.stayLocation, Commands.formationTarget(heldRecruit), 'joining Hold anchors at arrival, not the old solo location');
    Commands.handleCommand(player, '.p3 follow');
    Commands.handleCommand(player, '.p1 hold');
    assert(Commands.roster(first).every(s => s.botStay));
    assert.equal(second.owner.botStay, false, 'one party movement order does not move other groups');
    Commands.handleCommand(player, '.p1 follow');
    assert(Commands.roster(first).every(s => !s.botStay));
    const lootOwner = Party.groundLootOwnerId(first.owner);
    Commands.handleCommand(player, '.p1 regroup');
    assert.equal(Commands.canAttack(first.owner, player.actor), false, 'regroup pauses new offensive actions');
    assert.equal(Commands.handleMovement(first.owner, first.owner.actor), true, 'regroup moves the real bot leader too');
    first.regroupUntil = Date.now() - 1;
    assert.equal(Commands.canAttack(first.owner, player.actor), true, 'a timed out regroup releases its offensive hold');
    assert.equal(first.movement, 'follow');
    assert.notDeepEqual(Commands.formationTarget(first.owner), Commands.formationTarget(second.owner), 'parties have separate formation slots');
    const away = Manager.findSessionById(202);
    away.plan = 'getting_buffed';
    away.resumeAfterBuff = { plan: 'following', partyCompanion: true, followPlayerSession: first.owner,
        returnMode: 'teleport', returnTeleportStartedAt: Date.now() - 2000 };
    away.resumeAfterShopping = { plan: 'following', partyCompanion: true, followPlayerSession: first.owner };
    Commands.handleCommand(player, '.leader-p1 ClanBot203');
    assert.equal(first.owner.actor.fetchId(), 203);
    assert.equal(Party.groundLootOwnerId(first.owner), lootOwner, 'leadership changes preserve access to drops already on the ground');
    assert(Commands.roster(first).every(s => s.followPlayerSession === first.owner));
    assert.equal(away.resumeAfterShopping.followPlayerSession, first.owner, 'shopping resumes under the new leader too');
    patch(invoke('GameServer/Bot/AI/HotTownRebuff'), 'tripGuide', () => null);
    patch(invoke('GameServer/Bot/AI/PartyCombatState'), 'isActive', () => false);
    invoke('GameServer/Bot/AI/States/GettingBuffedState').tick(away, away.actor, {}, AI);
    restores.pop()(); restores.pop()();
    assert.equal(away.followPlayerSession, first.owner, 'completing a real town visit cannot restore the previous party owner');

    await seed(204);
    let reached, release;
    const reachedInvite = new Promise(resolve => { reached = resolve; });
    const releasedInvite = new Promise(resolve => { release = resolve; });
    const normalInvite = World.inviteBotByName;
    patch(World, 'inviteBotByName', async function(...args) {
        if (args[2] === 'ClanBot204') { reached(); await releasedInvite; }
        return normalInvite.apply(this, args);
    });
    Commands.handleCommand(player, '.invite-p1 ClanBot204');
    await reachedInvite;
    Commands.handleCommand(player, '.leader-p1 ClanBot202');
    release(); await first.pending;
    restores.pop()();
    assert.equal(first.owner.actor.fetchId(), 202);
    assert.equal(Commands.roster(first).length, 2, 'changing leaders cancels an in-flight invitation to the old owner');
    assert.equal((await row(204)).phase, 'cold', 'a cancelled invitation releases an unspawned hot claim');
    for (let id = 501; id <= 507; id++) { await seed(id); Commands.handleCommand(player, `.invite-p1 ClanBot${id}`); await first.pending; }
    assert.equal(Commands.roster(first).length, 9);
    await seed(508); Commands.handleCommand(player, '.invite-p1 ClanBot508'); await first.pending;
    assert.equal(Commands.roster(first).length, 9, 'all invites, including a concurrent activation, obey the per-party limit');
    assert.equal(Manager.findSessionById(508), undefined, 'a full additional party must reject before activating the bot');
    Commands.handleCommand(player, '.dismiss-p2');
    assert.equal(second.active, false);
    assert.equal(third.number, 3, 'dismissing a group does not renumber the remaining parties');
    assert.equal(third.active, true);
    Commands.handleCommand(player, '.kick-p1 ClanBot202');
    assert.notEqual(first.owner.actor.fetchId(), 202, 'removing the leader preserves the rest of the party');
    assert.equal(Commands.roster(first).length, 8);
    Commands.handleCommand(player, '.createparty ClanBot202');
    const fourth = player.commandParties.get(4); await fourth.pending;
    assert.equal(fourth.active, true, 'a released former leader can lead another party');
    assert.equal(first.lootLeaderId, fourth.lootLeaderId, 'the character-id reuse case is exercised');
    assert.notEqual(Party.groundLootOwnerKey(first.owner), Party.groundLootOwnerKey(fourth.owner),
        'independent party loot identities survive reuse of a former leader');
    const GroundItems = require('../src/GameServer/World/GroundItems');
    const drops = { spawns: [] };
    const firstDrop = { model: { partyLootLeaderId: first.lootLeaderId, partyLootGroupKey: first.lootKey } };
    const fourthDrop = { model: { partyLootLeaderId: fourth.lootLeaderId, partyLootGroupKey: fourth.lootKey } };
    GroundItems.put(drops, firstDrop); GroundItems.put(drops, fourthDrop);
    assert.deepEqual([...GroundItems.ownedBy(drops, first.lootKey)], [firstDrop], 'a party does not see another party loot even when their original leader ids match');
    assert.deepEqual([...GroundItems.ownedBy(drops, fourth.lootKey)], [fourthDrop]);
    GroundItems.take(drops, 0);
    assert.equal(GroundItems.ownedBy(drops, first.lootKey).size, 0);
    assert.equal(GroundItems.ownedBy(drops, fourth.lootKey).size, 1);
    await seed(601);
    let creationReached, releaseCreation;
    const creationEntered = new Promise(resolve => { creationReached = resolve; });
    const creationGate = new Promise(resolve => { releaseCreation = resolve; });
    const inviteBeforeCancel = World.inviteBotByName;
    patch(World, 'inviteBotByName', async function(...args) {
        if (args[2] === 'ClanBot601') { creationReached(); await creationGate; }
        return inviteBeforeCancel.apply(this, args);
    });
    Commands.handleCommand(player, '.createparty ClanBot601');
    const cancelled = player.commandParties.get(5);
    await creationEntered;
    Commands.handleCommand(player, '.dismiss-p5');
    const creationCancelled = !cancelled.active;
    releaseCreation(); await cancelled.pending;
    restores.pop()();
    assert.equal(creationCancelled, true, 'an assembling party can be dismissed before leader activation finishes');
    assert.equal(Manager.findSessionById(601)?.partyCompanion, undefined);
    const released = [...Commands.roster(first), ...Commands.roster(third), ...Commands.roster(fourth)];
    const deferredReturn = { plan: 'following', partyCompanion: true, followPlayerSession: third.owner };
    third.owner.resumeAfterBuff = deferredReturn;
    third.owner.preBuffPlan = 'following';
    Party.detachAll(player, { source: 'leader_disconnect', rebuildWindow: false, refreshPanel: false });
    assert.equal(player.commandParties.size, 0, 'disconnect uses the main-party lifecycle to dismiss every additional party');
    assert.equal(deferredReturn.followPlayerSession, null, 'disconnect also invalidates a town return snapshot already held by a callback');
    assert.equal(deferredReturn.partyCompanion, false);
    assert.equal(third.owner.resumeAfterBuff, undefined);

    assert(released.every(s => !s.partyCompanion && !s.followPlayerSession && !s.clanCommandParty));
    assert(messages.length > 0);
    restWithCommander();
    console.log('Clan command parties: native recruitment, three groups, nine-member limit, local support scopes, global loot settings, leadership, movement and disconnect passed');
}
// The bot leader of a command party ends its rest when the commander stands and
// walks to him; its members, seated beside it, stand and follow it.
function restWithCommander() {
    function walker(id, classId, x) {
        const a = { x, y: 0, seated: true, destId: null, moves: [],
            fetchId: () => id, fetchSelfId: () => id, fetchName: () => `ClanBot${id}`, fetchClassId: () => classId,
            fetchLevel: () => 40, fetchIsOnline: () => true, fetchClanId: () => 77, fetchHead: () => 0,
            fetchLocX: () => a.x, fetchLocY: () => a.y, fetchLocZ: () => 0,
            fetchHp: () => 1000, fetchMaxHp: () => 1000, fetchMp: () => 1000, fetchMaxMp: () => 1000,
            fetchCp: () => 100, fetchMaxCp: () => 100, fetchPDef: () => 100, fetchKarma: () => 0, fetchPvpFlag: () => 0,
            fetchDestId: () => a.destId, fetchAttackable: () => false, fetchIsRaidBoss: () => false,
            isDead: () => false, canUseSkill: () => true, setHp() {}, setMp() {}, refreshVitalsRegeneration() {},
            select({ id: target }) { a.destId = target; }, unselect() { a.destId = null; }, clearDestId() { a.destId = null; },
            moveTo(data) { a.moves.push(data); },
            backpack: { fetchTotalWeaponKind: () => 'Weapon.Sword', fetchEquippedArmors: () => [], fetchItems: () => [],
                fetchTotalLoad: () => 0, fetchMaxLoad: () => 1000 },
            skillset: { fetchSkill: () => null, fetchSkills: () => [], get skills() { return []; } },
            automation: { abortAll() {}, replenishVitals() {}, stopReplenish() {} },
            attack: { abortCast() {}, clearTimers() {}, resetQueuedEvent() {} },
            state: { fetchDead: () => false, setDead() {}, fetchHits: () => false, setHits() {}, fetchCasts: () => false,
                setCasts() {}, fetchTowards: () => false, fetchSeated: () => a.seated, setSeated(v) { a.seated = v; },
                fetchCombats: () => false } };
        const session = { actor: a, accountId: id >= 9000 ? 'player_9001' : `bot_clan_${id}`, plan: 'following',
            aiActive: true, dataSendToOthers() {}, dataSendToMeAndOthers() {}, dataSendToMe() {} };
        a.session = session;
        return session;
    }
    const commander = walker(9001, 0, 100);
    commander.actor.seated = false;
    const leader = walker(701, 5, 0), member = walker(702, 12, 0);
    const group = { active: true, number: 1, commander, commanderActor: commander.actor, owner: leader,
        leaderAssigned: true, movement: 'follow', members: new Set([leader, member]) };
    commander.commandParties = new Map([[1, group]]);
    for (const session of group.members) Object.assign(session, { partyCompanion: true, followPlayerSession: leader, clanCommandParty: group });
    const { registerSessions } = require('./helpers/worldSessions');
    registerSessions([commander, leader, member]);
    patch(Manager, 'sessions', [leader, member]);
    patch(World, 'npc', { spawns: [] });
    patch(World, 'fetchNpcsInRadius', () => []);
    const transit = invoke('GameServer/Bot/AI/CompanionTownTransit');
    patch(transit, 'tick', () => ({ handled: false }));
    patch(transit, 'sameTown', () => false);
    const Following = invoke('GameServer/Bot/AI/States/FollowingState');
    const ai = { say() {}, executeCombat() {}, wakeup() {} }, generics = { skillExec() {}, teleportTo() {} };

    leader.plan = 'resting';
    invoke('GameServer/Bot/AI/States/RestingState').tick(leader, leader.actor, generics, ai);
    assert.equal(leader.plan, 'following', 'a rested command leader ends its rest when the commander stands beside it');
    assert.equal(leader.actor.seated, false);

    commander.actor.x = 3000;
    Following.tick(leader, leader.actor, generics, ai);
    assert.equal(leader.actor.moves.length, 1, 'the command leader walks to the commander');
    Object.assign(leader.actor, { x: leader.actor.moves[0].to.locX, y: leader.actor.moves[0].to.locY });
    for (let tick = 0; tick < 2 && !member.actor.moves.length; tick++) {
        Following.tick(member, member.actor, generics, ai);
        assert.equal(member.actor.seated, false, 'a member does not sit again beside a walking leader');
    }
    assert.equal(member.actor.moves.length > 0, true, 'a member seated beside the leader follows it within two ticks');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    for (const session of Manager.sessions) { session.partyCompanion = false; session.followPlayerSession = null; }
    restores.reverse().forEach(restore => restore());
    await DB.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
});
