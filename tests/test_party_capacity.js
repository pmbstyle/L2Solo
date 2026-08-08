const assert = require('assert');

require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');

const originalSessions = BotManager.sessions;
try {
    const leader = { actor: { fetchId: () => 1 } };
    const companions = Array.from({ length: PartyCompanionService.MAX_COMPANIONS }, (_, index) => ({
        actor: { fetchId: () => index + 2 },
        partyCompanion: true,
        followPlayerSession: leader
    }));
    BotManager.sessions = companions;

    assert.strictEqual(PartyCompanionService.MAX_PARTY_MEMBERS, 9, 'hot party capacity should match the C4 nine-member party limit');
    assert.strictEqual(PartyCompanionService.hasCapacity(leader), false, 'a leader plus eight companions must be a full party');
    assert.strictEqual(PartyCompanionService.hasCapacity(leader, companions[0]), true, 'rebuilding an existing companion must not be rejected as a new ninth companion');

    const reservedLeader = { actor: { fetchId: () => 50 } };
    const reservation = { characterId: 5001 };
    BotManager.sessions = companions.slice(0, PartyCompanionService.MAX_COMPANIONS - 1).map((companion) => ({
        ...companion,
        followPlayerSession: reservedLeader
    }));
    assert.strictEqual(PartyCompanionService.reserveCapacity(reservedLeader, reservation), true, 'the last party slot can be reserved before async market withdrawal');
    assert.strictEqual(PartyCompanionService.hasCapacity(reservedLeader), false, 'a reserved slot must block a competing async invite');
    assert.strictEqual(PartyCompanionService.hasCapacity(reservedLeader, null, reservation), true, 'the reservation owner must retain access to its slot');
    assert.strictEqual(PartyCompanionService.reserveCapacity(reservedLeader, { characterId: 5002 }), false, 'a competing invite must not overbook the party');
    assert.strictEqual(PartyCompanionService.releaseCapacity(reservedLeader, reservation), true);
    assert.strictEqual(PartyCompanionService.hasCapacity(reservedLeader), true, 'releasing a failed invite must return its slot');

    const directionalLeader = {
        actor: {
            fetchLocX: () => 1000,
            fetchLocY: () => 2000,
            fetchLocZ: () => -3000,
            fetchHead: () => 16384
        }
    };
    const directionalCompanion = { actor: { fetchId: () => 99 }, followPlayerSession: directionalLeader, partyCompanion: true };
    BotManager.sessions = [directionalCompanion];
    assert.deepStrictEqual(
        PartyCompanionService.formationTargetFor(directionalCompanion),
        { locX: 1070, locY: 1910, locZ: -3000, slot: 0 },
        'formation offsets should rotate with the leader heading instead of staying fixed in world coordinates'
    );

    const tankCompanion = {
        actor: { fetchId: () => 100, fetchClassId: () => 4 },
        followPlayerSession: directionalLeader,
        partyCompanion: true
    };
    BotManager.sessions = [tankCompanion];
    assert.deepStrictEqual(
        PartyCompanionService.formationTargetFor(tankCompanion),
        { locX: 1000, locY: 2090, locZ: -3000, slot: 0 },
        'tanks should occupy the forward formation slot rather than the support line'
    );
} finally {
    BotManager.sessions = originalSessions;
}

console.log('Party capacity checks passed');
