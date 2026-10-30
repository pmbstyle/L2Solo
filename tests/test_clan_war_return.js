const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState'), War = invoke('GameServer/Clan/ClanWarRuntime');
const Spots = invoke('GameServer/Bot/AI/SpotService'), Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const Home = require('../src/GameServer/Bot/Population/ClanWarHome');
const Movement = require('../src/GameServer/Bot/Population/ClanWarMovement');
const Capacity = require('../src/GameServer/Bot/Population/ClanPartyCapacity');
const Lifecycle = require('../src/GameServer/Bot/Population/BackgroundPartyLifecycle');
const { beginHuntingTrip } = require('../src/GameServer/Bot/Population/HuntingTravel');
const { finishPartyRouteTravelState } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const { ClanWarDirector } = require('../src/GameServer/Clan/ClanWarDirector');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-war-return-'));
options.default.Database.path = path.join(dir, 'world.sqlite');
const at = Date.now(), ids = [1, 2, 3], partyId = 'stronghold-return';
// The live failure: a town location was paired with the previous farm's id.
const staleHome = { locX: 20175, locY: 146150, locZ: -3111 };
const home = { id: '15_7', name: "Pobby's Maid fields", center: { locX: 92300, locY: 46500, locZ: -3800 },
    minLevel: 50, maxLevel: 70, avgLevel: 60 };
const target = { id: '22_-2', name: 'Vanor Silenos Chieftain fields',
    center: { locX: 136356, locY: -10251, locZ: -4144 }, minLevel: 50, maxLevel: 70, avgLevel: 60 };
const original = { spots: Spots.spots, profiles: Profiles.cache, height: Geodata.getHeight };
const objective = { status: 'open', priority: 'required', clanId: 20, clanGoalKey: 'clan:20:gear' };
let director;
const current = () => ids.map(id => Life.cachedState(id));
async function run() {
    invoke('GameServer/DataCache').init(); DB.init();
    Spots.spots = [home, target]; Profiles.cache = [home, target]; Geodata.getHeight = (_x, _y, z) => z;
    assert(!Spots.containsLocation(home, staleHome));
    assert.deepEqual(Home.point({ homeSpotId: home.id, homeLoc: staleHome }), home.center);
    const valid = { locX: 92400, locY: 46400, locZ: -3800 };
    assert.deepEqual(Home.point({ homeLoc: valid }, home), valid, 'a valid original home is preserved');
    assert.deepEqual(Home.point({ homeLoc: { locX: null, locY: 1, locZ: 2 } }, home), home.center);
    assert.deepEqual(Home.point({ homeLoc: staleHome }, { ...home, center: staleHome, arrivalPoints: [valid] }), valid,
        'a known valid arrival point is used when a catalogue centre is unusable');
    assert.equal(Home.point({ homeLoc: staleHome }, { ...home, center: staleHome }), null, 'invalid geometry cannot fabricate completion');

    await DB.execute(["INSERT INTO accounts(username,password) VALUES ('bot_war_return','test')"]);
    await DB.execute(["INSERT INTO clans(id,name,leaderId,level) VALUES (10,'ReturnA',1,3),(20,'ReturnB',16,3)"]);
    await DB.execute(["INSERT INTO clan_simulation_clans(clanId,version,mode,createdAt,updatedAt,stateJson) VALUES (10,1,'autonomous',?,?,?)", [at, at, '{}']]);
    await DB.execute(['INSERT INTO clan_war_declarations(fromClanId,toClanId,active,revision,declaredAt,updatedAt) VALUES (10,20,1,1,?,?),(20,10,1,2,?,?)', [at, at, at, at]]);
    await War.refresh(true);
    for (const id of ids) {
        await DB.execute([`INSERT INTO characters(id,username,name,classId,race,level,hp,maxHp,mp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
            VALUES (?,'bot_war_return',?,0,0,60,1000,1000,500,500,0,0,0,0,136356,-10251,-4144,10)`, [id, `ReturnFighter${id}`]]);
        await DB.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,spotId,hp,maxHp,mp,maxMp,level,locX,locY,locZ,nextResolveAt,lastResolvedAt,updatedAt,statsJson)
            VALUES (?,'bot_war_return',?,'cold','hunting',?,1000,1000,500,500,60,136356,-10251,-4144,?,?,?,?)`,
        [id, `ReturnFighter${id}`, target.id, at, at - 1000, at, JSON.stringify({ clanId: 10, classId: id === 3 ? 15 : 0 })]]);
    }
    await Life.init(); await Parties.init();
    const op = { id: 'legacy-return', clanId: 10, enemyClanId: 20, status: 'returning', outcome: 'spot_cleared',
        targetSpotId: target.id, targetLoc: target.center, homeSpotId: home.id, homeLoc: staleHome, expiresAt: at - 1 };
    const prepared = Parties.prepareCommit({ partyId, leaderId: 1, memberIds: ids, spotId: target.id, status: 'active',
        startedAt: at - 1000000, nextResolveAt: at, stats: { warOperation: op, sessionExpiresAt: at - 1 } });
    const assigned = current().map(s => Life.preparePartyAssignment(s, partyId, s.characterId === 3 ? 'healer' : 'dps', 1, at));
    const committed = await DB.commitBackgroundPartyMembership({ party: prepared.row, members: assigned });
    assert(committed.ok, committed.reason); Life.acceptPartyAssignments(assigned, committed.lifeRows); Parties.acceptRow(committed.partyRow);

    const NativeMove = invoke('GameServer/Bot/AI/BotClanWarOperation');
    const Travel = invoke('GameServer/Bot/AI/BotSpotTravel'), Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
    const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
    const originals = { start: Travel.start, stop: Tactics.stop, canUse: Restrictions.canUseBasicAction };
    let location = target.center, nativeDestination;
    const actor = { fetchClanId: () => 10, fetchLocX: () => location.locX, fetchLocY: () => location.locY,
        fetchLocZ: () => location.locZ, state: { fetchCasts: () => false } };
    const session = { actor };
    try {
        Restrictions.canUseBasicAction = () => true; Tactics.stop = () => {};
        Travel.start = (_session, _actor, _spot, point) => { nativeDestination = point; return true; };
        assert(NativeMove.tick(session, actor, Parties.find(partyId), at));
        assert.deepEqual(nativeDestination, home.center, 'a visible party also repairs an old home outside its spot');
        location = home.center; nativeDestination = null;
        assert(NativeMove.tick(session, actor, Parties.find(partyId), at));
        assert.equal(session.lastDecision.action, 'clan_war_home'); assert.equal(nativeDestination, null);
    } finally { Travel.start = originals.start; Tactics.stop = originals.stop; Restrictions.canUseBasicAction = originals.canUse; }

    assert(!Lifecycle.sessionExpired(Parties.find(partyId), at));
    for (const status of ['assembling', 'engaging', 'returning']) assert(!Capacity.elective({ ...Parties.find(partyId),
        stats: { warOperation: { ...op, status } } }, at), 'an unfinished military order retains its slot after its deadline');
    assert(!await Capacity.reclaim(objective, { parties: Parties, life: Life, database: DB,
        metrics: { recordPartyDissolution() { throw Error('a military party cannot be reclaimed'); } } }, at));
    const before = await DB.execute(['SELECT characterId,partyId,updatedAt,simulationRevision FROM bot_life_state ORDER BY characterId']);
    const eviction = Parties.prepareCommit({ ...Parties.find(partyId), status: 'dissolved', memberIds: [], stats: {} });
    const releases = current().map(s => Life.preparePartyReview(s, Lifecycle.releaseMember(s, at, 'clan_priority')));
    const refused = await DB.commitBackgroundPartyMembership({ party: eviction.row, members: releases, review: true,
        preserveClanOperations: true, expectedPartyRevision: Parties.find(partyId).revision });
    assert.equal(refused.reason, 'clan_war_in_progress', 'the writer refuses even a candidate that omitted its current military order');
    assert.deepEqual(await DB.execute(['SELECT characterId,partyId,updatedAt,simulationRevision FROM bot_life_state ORDER BY characterId']), before,
        'refused reclamation has no partial membership effects');

    director = new ClanWarDirector({ database: DB, life: Life, parties: Parties, war: War });
    const oldRevision = Parties.find(partyId).revision;
    const staleSupplySave = Parties.find(partyId);
    await director.maintain(Parties.find(partyId), at);
    assert.deepEqual(Parties.find(partyId).stats.warOperation.homeLoc, home.center, 'a legacy order is repaired once in durable state');
    assert.equal((await DB.setClanWarPartyOperation(partyId, oldRevision, op)).reason, 'party_changed', 'stale arrival/operation writes cannot undo the repair');
    const afterLateSupply = await Parties.createOrUpdate({ ...staleSupplySave,
        stats: { ...staleSupplySave.stats, lastMarketBreakAt: at } }, { preserveWarOperation: true });
    assert.deepEqual(afterLateSupply.stats.warOperation.homeLoc, home.center,
        'a delayed supply-roster save cannot undo the current return anchor');
    const repairedRevision = Parties.find(partyId).revision;
    await director.maintain(Parties.find(partyId), at + 1);
    assert.equal(Parties.find(partyId).revision, repairedRevision, 'waiting for a real arrival does not write repeatedly');
    const route = Movement.route({ leader: current()[0], party: Parties.find(partyId), members: current(), spot: target,
        timestamp: at, spots: [home, target], wars: War.view }).route;
    assert(route?.needed && route.cause === 'clan_war_return');
    const traveling = current().map(s => beginHuntingTrip(s, route, at));
    const arrivalAt = Math.max(...traveling.map(s => s.stats.travel.arrivalAt));
    assert(arrivalAt > at); assert.equal(finishPartyRouteTravelState(traveling[0], at), null);
    const arrived = traveling.map(s => finishPartyRouteTravelState(s, arrivalAt));
    assert(arrived.every(s => s.spotId === home.id && Spots.containsLocation(home, s.loc)
        && Math.hypot(s.loc.locX - home.center.locX, s.loc.locY - home.center.locY) < 900));
    for (let i = 0; i < ids.length; i++) await Life.upsertState(i === 2 ? traveling[i] : arrived[i]);
    await director.maintain(Parties.find(partyId), arrivalAt);
    assert(Parties.find(partyId).stats.warOperation, 'the whole roster must finish traveling before the order is released');
    await Life.upsertState(arrived[2]);
    const settled = Movement.route({ leader: current()[0], party: Parties.find(partyId), members: current(), spot: home,
        timestamp: arrivalAt, spots: [home, target], wars: War.view });
    assert(settled.active && !settled.route, 'a completed arrival does not start another trip to the same spot');
    await director.maintain(Parties.find(partyId), arrivalAt + 1);
    assert.equal(Parties.find(partyId).stats.warOperation, null, 'the native owner closes the order after physical return');
    assert.equal(Parties.find(partyId).spotId, home.id);
    const completed = Parties.find(partyId);
    const afterCompletionSave = await Parties.createOrUpdate({ ...completed,
        stats: { ...completed.stats, warOperation: op, lastMarketBreakAt: arrivalAt } }, { preserveWarOperation: true });
    assert.equal(afterCompletionSave.stats.warOperation, null, 'a delayed supply-roster save cannot resurrect a completed operation');
    assert(Capacity.elective(Parties.find(partyId), arrivalAt + 2));
    assert(await Capacity.reclaim(objective, { parties: Parties, life: Life, database: DB,
        metrics: { recordPartyDissolution() {} } }, arrivalAt + 2), 'ordinary capacity rules resume after the military order has finished');
    assert.equal((await DB.execute(['SELECT status FROM bot_background_parties WHERE partyId=?', [partyId]]))[0].status, 'dissolved');
    assert(current().every(s => !s.party?.partyId && !s.partyId));
    console.log('Clan war return: live StrongHold coordinates, durable legacy repair, physical whole-party arrival, no repeated travel, expired-order protection, atomic reclamation refusal and ordinary reuse after completion passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Spots.spots = original.spots; Profiles.cache = original.profiles; Geodata.getHeight = original.height;
    await DB.close(); fs.rmSync(dir, { recursive: true, force: true });
});
