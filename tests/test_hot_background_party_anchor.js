const assert = require('assert');
require('../src/Global');
const Party = invoke('GameServer/Bot/AI/HotBackgroundParty');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const World = invoke('GameServer/World/World');
const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Raid = invoke('GameServer/Bot/AI/BotRaidSafety');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Travel = invoke('GameServer/Bot/AI/BotSpotTravel');
const nativeTravelStart = Travel.start;
const Revival = invoke('GameServer/Bot/AI/PartyRevivalService');
const Journal = invoke('GameServer/Bot/AI/BotEventJournal');
const TownTransit = invoke('GameServer/Bot/AI/TownTransitPolicy');
const Generics = invoke(path.actor);
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const saved = [];
function replace(object, key, value) { const old = object[key]; saved.push(() => object[key] = old); object[key] = value; }
// x < 4000 is inside the party's spot; a bot with `town` stands in a town.
function actor(id, x = 0, kind = null) {
    return { x, hp: 100, town: false, fetchId: () => id, fetchSelfId: () => id, fetchKind: kind ? () => kind : undefined,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchHp() { return this.hp; }, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
        fetchLevel: () => 20, fetchIsOnline: () => true, isDead() { return this.hp <= 0; },
        state: { seated: false, casts: false, fetchSeated() { return this.seated; }, setSeated(v) { this.seated = v; },
            fetchCasts() { return this.casts; }, setCasts(v) { this.casts = v; } },
        automation: { replenishVitals() {}, abortAll() {} },
        select({ id }) { this.targetId = id; }, unselect() { this.targetId = undefined; },
        fetchDestId() { return this.targetId; }, clearDestId() { this.targetId = undefined; },
        moveTo(coords) { this.moved = true; this.move = coords; } };
}
try {
    replace(Geo, 'hasLineOfSight', () => true);
    const group = [1, 2, 3].map(id => ({ accountId: `bot_hot_anchor_${id}`, fetchAccountId() { return this.accountId; },
        hotBackgroundPartyId: 'anchor', actor: actor(id), dataSendToOthers() {}, dataSendToMeAndOthers() {} }));
    const [leader, healer, follower] = group;
    const party = { partyId: 'anchor', leaderId: 1, memberIds: [1, 2, 3], status: 'hot', spotId: 'S',
        stats: { objective: { npcId: 20 } } };
    const spot = { id: 'S', arrivalPoints: [] };
    replace(Parties, 'find', () => party);
    replace(World, 'user', { sessions: [], revision: 0 });
    group.forEach(session => World.insertUser(session));
    replace(World, 'fetchNpcsInRadius', () => []);
    replace(Awareness, 'npcThreateningActor', s => s.incoming || null);
    replace(Restrictions, 'canUseBasicAction', () => true);
    replace(Restrictions, 'canMove', () => true);
    replace(Raid, 'isProtectedRaidEntity', () => false);
    replace(Tactics, 'stop', () => {});
    replace(Tactics, 'support', () => false);
    replace(Spots, 'findById', () => spot);
    replace(Spots, 'containsLocation', (_spot, point) => point.locX < 4000);
    replace(TownTransit, 'townAt', a => a.town ? 'Giran' : null);
    const travel = { start: [], tick: [] };
    let startResult = true;
    replace(Travel, 'start', (s, a, to, at) => { travel.start.push([s, a, to, at]); return startResult; });
    replace(Travel, 'tick', (s) => { travel.tick.push(s); return true; });
    const attacks = [];
    const AI = { executeCombat(s, _bot, target) { attacks.push([s, target]); } };
    const tick = (s, now = 20000) => Party.tick(s, s.actor, Generics, AI, now);

    // A member restarted in town is not waited for: the leader keeps searching.
    follower.actor.x = 50000; follower.actor.town = true;
    tick(leader);
    assert.notStrictEqual(leader.lastDecision.action, 'party_wait_roster', 'the leader does not wait for a member in town');
    // A member at the spot but away from the leader is still waited for.
    follower.actor.x = 1500; follower.actor.town = false;
    tick(leader, 21000);
    assert.strictEqual(leader.lastDecision.action, 'party_wait_roster', 'the leader waits for a member at the spot');

    // The town member returns to the party's spot by gatekeeper, not toward the leader.
    follower.actor.x = 50000; follower.actor.town = true;
    tick(follower);
    assert.strictEqual(travel.start.length, 1, 'a town-restarted member starts the gatekeeper travel');
    assert.deepStrictEqual([travel.start[0][0], travel.start[0][2]], [follower, spot], 'to the party spot');
    assert.strictEqual(follower.lastDecision.action, 'party_return_to_spot');
    assert(!follower.actor.moved, 'the member does not walk toward the leader');
    follower.spotRelocation = { method: 'town_gatekeeper' };
    tick(follower, 21000);
    assert.deepStrictEqual(travel.tick, [follower], 'a running travel is ticked by the party controller');
    assert.strictEqual(travel.start.length, 1);
    follower.spotRelocation = undefined;
    startResult = false;
    tick(follower, 22000);
    assert(!follower.actor.moved, 'a refused travel (retry cooldown) idles instead of walking to town');
    startResult = true;

    // The leader is the one in town: the member at the spot regroups to the first member there.
    leader.actor.x = 50000; leader.actor.town = true;
    follower.actor.x = 3000; follower.actor.town = false;
    healer.actor.x = 100;
    follower.actor.moved = false;
    tick(follower, 23000);
    assert.strictEqual(follower.actor.move.to.locX, 100, 'members regroup at the first member at the spot, not at the leader');
    travel.start.length = 0;
    tick(leader, 23000);
    assert.strictEqual(travel.start.length, 1, 'the leader in town returns to the spot too');
    // The member at the spot leads the hunt meanwhile: no pull waits for the leader in town.
    healer.nextBackgroundTargetScanAt = 0;
    tick(healer, 24000);
    assert.notStrictEqual(healer.lastDecision.action, 'party_wait', 'the member at the spot is not parked behind the leader in town');

    // E73: a member in town goes back even while the party fights (the
    // party's incoming mob is no target for it), lands beside the member who
    // leads at the spot and drops a target held from before, which would
    // otherwise cancel the travel as combat.
    leader.actor.x = 100; leader.actor.town = false;
    healer.actor.x = 200;
    follower.actor.x = 50000; follower.actor.town = true;
    follower.spotRelocation = undefined; follower.currentTargetId = 4242; follower.actor.moved = false;
    const mob = { ...actor(900, 300, 'Monster'), fetchAttackable: () => true };
    leader.incoming = mob;
    travel.start.length = 0;
    tick(follower, 25000);
    assert.strictEqual(follower.lastDecision.action, 'party_return_to_spot', 'the party fight does not hold a member in town');
    assert.strictEqual(travel.start.length, 1);
    assert.strictEqual(travel.start[0][3].locX, 100, 'it returns beside the leader at the spot, not to the spot centre');
    assert.strictEqual(follower.currentTargetId, undefined, 'a stale target does not cancel the travel');
    assert(!follower.actor.moved, 'it does not walk from town toward the party mob');
    leader.incoming = null;

    // E73: the leader stepping over the spot cell edge stays the leader: the
    // others regroup to it instead of electing the first member inside.
    leader.actor.x = 4500;
    follower.actor.x = 100; follower.actor.town = false;
    tick(follower, 26000);
    assert.strictEqual(follower.lastDecision.action, 'party_regroup', 'the leader past the cell edge still leads');
    assert.strictEqual(follower.actor.move.to.locX, 4500);
    // ...but a leader travelling back from town does not lead.
    leader.spotRelocation = { method: 'town_gatekeeper' };
    follower.actor.moved = false;
    tick(follower, 27000);
    assert.notStrictEqual(follower.lastDecision.action, 'party_regroup', 'a leader on its way back from town is not followed');
    leader.spotRelocation = undefined;
    // The leader away (in town): the owner is the first member AT the spot, not the first one merely not away
    // (the healer, past the cell edge but not in town, comes first in the roster).
    leader.actor.x = 50000; leader.actor.town = true;
    healer.actor.x = 4500; healer.actor.town = false;
    follower.actor.x = 100; follower.actor.town = false;
    healer.actor.moved = false;
    tick(healer, 28000);
    assert.strictEqual(healer.lastDecision.action, 'party_regroup');
    assert.strictEqual(healer.actor.move.to.locX, 100, 'the member past the edge regroups to the one at the spot');

    // A restored player party can be stranded in a different hunting area,
    // with no town gatekeeper and no acceptable local target.
    group.forEach((s, index) => {
        s.actor.x = 50000 + index * 100;
        s.actor.town = false;
        s.actor.moved = false;
        s.backgroundPartyReturn = { partyId: party.partyId, spotId: spot.id };
        s.currentTargetId = undefined;
        s.backgroundHuntTarget = null;
    });
    travel.start.length = 0;
    group.forEach(s => tick(s, 30000));
    assert.strictEqual(travel.start.length, 3, 'every restored member starts returning from the field');
    assert(group.every(s => s.lastDecision.action === 'party_return_to_spot' && !s.actor.moved),
        'the restored group travels to its spot instead of searching locally or following a departing leader');
    assert(travel.start.every(call => call[2] === spot && call[3] === null),
        'when the whole group is away, every member returns to the same spot destination');

    // A rejected attempt keeps the return intent for the next safe retry.
    startResult = false;
    tick(leader, 31000);
    assert(leader.backgroundPartyReturn, 'a travel cooldown must not lose the return intent');
    assert.strictEqual(leader.lastDecision.action, 'party_return_to_spot');
    startResult = true;

    // An NPC attacking a companion keeps the nearby group defending until
    // the fight is over; stale target selection must not hold it afterwards.
    travel.start.length = 0;
    attacks.length = 0;
    const fieldMob = { ...actor(901, 50100, 'Monster'), fetchAttackable: () => true };
    healer.incoming = fieldMob;
    tick(leader, 32000);
    assert.strictEqual(travel.start.length, 0, 'return waits for a nearby companion under attack');
    assert.strictEqual(attacks.at(-1)?.[1], fieldMob, 'the group defends before returning');
    assert(leader.backgroundPartyReturn, 'combat does not consume the pending return');
    healer.incoming = null;
    fieldMob.hp = 0;
    tick(leader, 33000);
    assert.strictEqual(travel.start.length, 1, 'the return resumes after combat');
    assert.strictEqual(leader.currentTargetId, undefined, 'the old combat target does not cancel return travel');

    // The first arrivals wait for the roster rather than pulling alone.
    leader.actor.x = 100;
    tick(leader, 34000);
    assert.strictEqual(leader.backgroundPartyReturn, undefined, 'arrival completes this member\'s return');
    assert.strictEqual(leader.lastDecision.action, 'party_wait_roster', 'the first arrival waits for returning companions');
    travel.start.length = 0;
    tick(follower, 35000);
    assert.strictEqual(travel.start[0][3].locX, 100, 'later members land beside the party member already at the spot');
    healer.actor.x = 200;
    follower.actor.x = 300;
    const farmMob = { ...actor(902, 400, 'Monster'), fetchAttackable: () => true };
    replace(World, 'fetchNpcsInRadius', () => [farmMob]);
    leader.nextBackgroundTargetScanAt = 0;
    group.forEach(s => tick(s, 36000));
    assert(group.every(s => s.backgroundPartyReturn === undefined && s.lastDecision.action === 'party_hunt'),
        'the complete restored roster resumes farming after arrival');

    // A return marker cannot redirect a different party or an updated route.
    leader.backgroundPartyReturn = { partyId: 'old-party', spotId: spot.id };
    healer.backgroundPartyReturn = { partyId: party.partyId, spotId: 'old-spot' };
    group.forEach(s => tick(s, 37000));
    assert.strictEqual(leader.backgroundPartyReturn, undefined);
    assert.strictEqual(healer.backgroundPartyReturn, undefined);

    // One member has arrived, but the leader and healer are still together
    // in the field. The healer must defend locally, and the arrival must wait.
    leader.actor.x = 50000;
    healer.actor.x = 50100;
    follower.actor.x = 100;
    group.forEach(s => {
        s.actor.moved = false;
        s.currentTargetId = undefined;
        s.backgroundHuntTarget = null;
        s.backgroundPartyReturn = { partyId: party.partyId, spotId: spot.id };
    });
    const attackingLeader = { ...actor(991, 50050, 'Monster'), fetchAttackable: () => true,
        fetchDestId: () => leader.actor.fetchId() };
    leader.incoming = attackingLeader;
    replace(World, 'fetchNpcsInRadius', () => [attackingLeader, farmMob]);
    Awareness.invalidateThreatProjection(leader);
    assert(Revival.partyCombatInProgress(leader), 'the actual combat projection sees the separated leader under attack');
    attacks.length = 0;
    tick(healer, 38000);
    assert.strictEqual(healer.lastDecision.action, 'party_hunt', 'the healer helps its nearby leader despite the distant arrival');
    assert.strictEqual(attacks.at(-1)?.[1], attackingLeader);
    assert(!healer.actor.moved, 'the healer does not abandon the local fight to regroup across the map');
    follower.nextBackgroundTargetScanAt = 0;
    tick(follower, 38000);
    assert.strictEqual(follower.lastDecision.action, 'party_wait_roster', 'the first arrival does not start a new pull during remote party combat');
    assert(!attacks.some(([s]) => s === follower), 'the first arrival waits at the spot');
    follower.actor.x = 80000;
    follower.actor.town = true;
    follower.backgroundPartyReturn = { partyId: party.partyId, spotId: spot.id };
    follower.spotRelocation = { method: 'town_gatekeeper', spotId: spot.id };
    travel.start.length = 0;
    tick(follower, 39000);
    assert.strictEqual(follower.spotRelocation, undefined, 'a restored member also cancels gatekeeper travel while the party fights');
    assert.strictEqual(travel.start.length, 0, 'the legacy town branch must not immediately restart interrupted party return');
    assert.strictEqual(follower.lastDecision.action, 'party_wait_roster');
    follower.actor.town = false;
    leader.incoming = null;
    attackingLeader.hp = 0;
    Awareness.invalidateThreatProjection(leader);

    // Exercise real SoE channels and completion callbacks, including an attack
    // between the final AI tick and cast completion.
    replace(Travel, 'start', nativeTravelStart);
    const timers = [];
    replace(global, 'setTimeout', (fn, delay) => { timers.push({ fn, delay }); return 0; });
    replace(Spots, 'assignSpot', (s, target) => { s.currentSpot = target; });
    replace(Journal, 'record', async () => {});
    replace(Generics, 'updatePosition', (_s, bot, to) => { bot.x = to.locX; });
    spot.center = { locX: 100, locY: 0, locZ: 0 };
    group.forEach((s, index) => {
        s.actor.x = 50000 + index * 100;
        s.actor.state.setCasts(false);
        s.currentTargetId = undefined;
        s.backgroundHuntTarget = null;
        s.backgroundPartyReturn = { partyId: party.partyId, spotId: spot.id };
    });
    replace(World, 'fetchNpcsInRadius', () => []);
    tick(leader, 40000);
    assert.strictEqual(leader.spotRelocation?.method, 'soe_gatekeeper');
    assert.strictEqual(leader.actor.state.fetchCasts(), true);
    const interruptedCast = timers.find(timer => timer.delay === Travel.SOE_CAST_MS);
    assert(interruptedCast, 'return uses the real 20-second SoE channel');
    const attackingHealer = { ...actor(993, 50100, 'Monster'), fetchAttackable: () => true,
        fetchDestId: () => healer.actor.fetchId() };
    healer.incoming = attackingHealer;
    replace(World, 'fetchNpcsInRadius', () => [attackingHealer]);
    Awareness.invalidateThreatProjection(healer);
    assert(Revival.partyCombatInProgress(leader), 'the actual combat projection sees an attacked companion during SoE');
    tick(leader, 41000);
    assert.strictEqual(leader.spotRelocation, undefined, 'party combat cancels SoE before the casting early return');
    assert.strictEqual(leader.actor.state.fetchCasts(), false);
    assert.strictEqual(leader.lastDecision.action, 'party_hunt', 'the former caster immediately helps its companion');
    interruptedCast.fn();
    assert.strictEqual(leader.actor.x, 50000, 'the cancelled SoE callback cannot teleport out of the fight');
    assert.strictEqual(leader.spotRelocation, undefined);

    healer.incoming = null;
    attackingHealer.hp = 0;
    Awareness.invalidateThreatProjection(healer);
    tick(leader, 42000);
    assert.strictEqual(leader.spotRelocation?.method, 'soe_gatekeeper', 'return retries after combat');
    const completionCast = timers.filter(timer => timer.delay === Travel.SOE_CAST_MS).at(-1);
    attackingHealer.hp = 100;
    healer.incoming = attackingHealer;
    // ReceivedHit invalidates this shared projection before waking the AI.
    Awareness.invalidateThreatProjection(healer);
    // No tick between the new hit and this callback: the completion itself
    // must fence the party's combat state.
    completionCast.fn();
    assert.strictEqual(leader.spotRelocation, undefined, 'SoE completion rechecks the party when no new AI tick has run');
    assert.strictEqual(leader.lastSpotRelocation.reason, 'combat_interrupt');
    assert.strictEqual(leader.actor.x, 50000);
    healer.incoming = null;
    attackingHealer.hp = 0;
    Awareness.invalidateThreatProjection(healer);

    timers.length = 0;
    group.forEach(s => tick(s, 43000));
    const completedCasts = timers.filter(timer => timer.delay === Travel.SOE_CAST_MS);
    assert.strictEqual(completedCasts.length, group.length, 'the whole group retries its return after combat');
    completedCasts.forEach(timer => timer.fn());
    timers.filter(timer => timer.delay === 1000 || timer.delay === Travel.TELEPORT_SETTLE_MS).forEach(timer => timer.fn());
    assert(group.every(s => s.actor.x === spot.center.locX), 'real travel completion places the entire party on its spot');
    replace(World, 'fetchNpcsInRadius', () => [farmMob]);
    leader.nextBackgroundTargetScanAt = 0;
    group.forEach(s => tick(s, 44000));
    assert(group.every(s => s.lastDecision.action === 'party_hunt' && !s.backgroundPartyReturn),
        'farming resumes after interrupted real channels eventually complete');
    console.log('Hot background party anchor: roster wait, regroup and return from town or player party passed');
} finally { saved.reverse().forEach(restore => restore()); }
