const assert = require('assert');

require('../src/Global');

const Lifecycle = require('../src/GameServer/Bot/Population/BackgroundPartyLifecycle');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');

// A competition "offer_party" pins the party to the shared target's ground.
// Once the party outlevels that ground, its session review drops the
// objective and the party routes like any other party.
const at = 1800000000000;
const elpy = { id: 'elpy', minLevel: 1, maxLevel: 3, avgLevel: 2 };
const wolves = { id: 'wolves', minLevel: 10, maxLevel: 14, avgLevel: 12 };
const sharedTarget = { reason: 'shared_target', spotId: 'elpy', npcId: 432 };
const partyFor = (objective, spotId = objective.spotId) => ({ partyId: 'shared', leaderId: 1, memberIds: [1, 2],
    status: 'active', spotId, nextResolveAt: at, stats: { objective, fightsWon: 10, fightsResolved: 10, lastProgressAt: at } });
const membersFor = (level) => [1, 2].map((characterId) => ({ characterId, name: `Hunter${characterId}`, level,
    phase: 'cold', activity: 'grouped', party: { partyId: 'shared', leaderId: 1, role: 'dps' },
    vitals: { hp: 500, maxHp: 500, mp: 200, maxMp: 200 }, timing: { nextResolveAt: at }, stats: { classId: 0, role: 'dps' } }));
const review = (party, members, spot) => Lifecycle.review(party, members, at, { spot }).party;

assert.strictEqual(review(partyFor(sharedTarget), membersFor(12), elpy).stats.objective, null,
    'an outgrown shared target ends in the party review');
assert.deepStrictEqual(review(partyFor({ kind: 'shared_target', spotId: 'elpy', npcId: 432 }), membersFor(12), elpy).stats.objective,
    null, 'a hot competition party (kind) ends the same way');
assert.deepStrictEqual(review(partyFor(sharedTarget), membersFor(3), elpy).stats.objective, sharedTarget,
    'a party that still fits its shared target keeps it');
const strong = { ...sharedTarget, spotId: 'wolves' };
assert.deepStrictEqual(review(partyFor(strong), membersFor(3), wolves).stats.objective, strong,
    'ground with stronger mobs keeps the pin');
const clanHelp = { ...sharedTarget, reason: 'clan_help' };
assert.deepStrictEqual(review(partyFor(clanHelp), membersFor(12), elpy).stats.objective, clanHelp,
    'other objectives keep pinning');
assert.deepStrictEqual(review(partyFor(sharedTarget, 'wolves'), membersFor(12), wolves).stats.objective, sharedTarget,
    'the review judges only the ground the party stands on');
assert.deepStrictEqual(review(partyFor(sharedTarget), membersFor(12), null).stats.objective, sharedTarget,
    'without its ground the review keeps the objective');

// The cold kernel reviews a party with its current ground.
(async () => {
    const party = { ...partyFor(sharedTarget), cohesion: 1,
        stats: { ...partyFor(sharedTarget).stats, sessionReview: { at: at - 300000, nextAt: at - 1, wins: 5, fights: 5 } } };
    const members = membersFor(12).map((s) => ({ ...s, spotId: 'elpy', loc: { locX: -84000, locY: 244000, locZ: -3700 },
        timing: { lastResolvedAt: at - 45000, nextResolveAt: at } }));
    const messages = [];
    const kernel = new ColdSimulationKernel({ now: () => at,
        resolveSolo: () => { throw Error('party must not become solo combat'); },
        resolveParty: () => { throw Error('a due review comes before combat'); },
        emit: (type, payload) => messages.push({ type, payload }),
        projectResolve: (state, result) => ({ ...state, ...result.patch }) });
    kernel.partyRuns.set(party.partyId, { party, members, spot: elpy, route: null,
        grants: new Map(members.map((s) => [s.characterId, { characterId: s.characterId,
            leaseId: `review-${s.characterId}`, revision: 1 }])) });
    await kernel.resolvePartyGrant(party.partyId);
    const batch = messages.find((m) => m.type === 'proposal_batch');
    assert(batch, JSON.stringify(messages));
    const reviewed = batch.payload.proposals.find((p) => p.partyResolution).partyResolution.party;
    assert.strictEqual(reviewed.stats.objective, null, 'the kernel review ends the outgrown shared target');
    console.log('party shared target outgrown: ok');
})().catch((err) => { console.error(err); process.exit(1); });
