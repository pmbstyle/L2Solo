const assert = require('assert');
require('../src/Global');
const RequiredPartyFormation = require('../src/GameServer/Bot/Population/RequiredPartyFormation');

// While a player is online only the player-safe formation runs (the cold worker
// proposes, the main thread hydrates at most the proposal). It assembles
// required requests and, by the persona rule of the background formation,
// preferred ones.
const social = { primaryDrive: 'social', traits: { sociability: 0.9, commitment: 0.8, empathy: 0.7, caution: 0.5, ambition: 0.5, assertiveness: 0.5, resilience: 0.5 } };
const loner = { primaryDrive: 'wealth', traits: { sociability: 0.1, commitment: 0.1, empathy: 0.1, caution: 0.5, ambition: 0.5, assertiveness: 0.5, resilience: 0.5 } };
function bot(characterId, { priority, spotId = 'spot_a', persona = social, level = 30, requestedAt = 1000 } = {}) {
    return {
        characterId, name: `Bot${characterId}`, level, phase: 'cold', activity: 'hunting', spotId, persona,
        party: { partyId: null, role: 'dps', leaderId: null },
        stats: { role: 'dps', partyRequest: { status: 'open', priority, requestedAt, spotId, npcId: 20001 } },
        timing: { activityStartedAt: requestedAt }, simulation: { ownerId: 'legacy_main', revision: 1 }, updatedAt: 5000
    };
}

const willing = [bot(1, { priority: 'preferred' }), bot(2, { priority: 'preferred' }), bot(3, { priority: 'preferred' })];
const proposal = RequiredPartyFormation.proposalFromStates(willing, { candidateLimit: 12 });
assert.deepStrictEqual(proposal.candidates.map(c => c.characterId), [1, 2, 3], 'willing preferred requests are proposed');
assert.strictEqual(proposal.requiredCount, 0, 'the required backlog counts only required requests');

const solo = [bot(11, { priority: 'preferred', persona: loner }), bot(12, { priority: 'preferred', persona: loner })];
assert.deepStrictEqual(RequiredPartyFormation.proposalFromStates(solo, { candidateLimit: 12 }).candidates, [],
    'a bot that prefers solo by its persona is not pulled into a preferred party');
assert.strictEqual(RequiredPartyFormation.objectiveFor(bot(13, { priority: 'required', persona: loner }))?.priority, 'required',
    'a required request is accepted whatever the persona');

const mixed = [
    ...[21, 22, 23, 24].map(id => bot(id, { priority: 'preferred', spotId: 'spot_big' })),
    ...[31, 32].map(id => bot(id, { priority: 'required', spotId: 'spot_req', requestedAt: 2000 }))
];
assert.strictEqual(RequiredPartyFormation.proposalFromStates(mixed, { candidateLimit: 12 }).spotId, 'spot_req',
    'a group with a required request goes before a larger preferred group');
console.log('test_player_safe_preferred_parties: ok');
