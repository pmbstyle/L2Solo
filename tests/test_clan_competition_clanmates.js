const assert = require('assert');
require('../src/Global');
const Policy = require('../src/GameServer/Social/ResourceCompetitionPolicy');

// Two bots on a crowded spot: a clanmate is met as a friend (the 'friendly'
// stance of InteractionMemoryPolicy), so it is invited or tolerated rather than
// disputed. Real hostility between clanmates still counts.
const persona = { traits: { sociability: 0.5, commitment: 0.5, caution: 0.5, ambition: 0.5, assertiveness: 0.5, empathy: 0.5, resilience: 0.5 } };
const relation = (sourceClanId, targetClanId, personal = { affinity: 0, trust: 0, hostility: 0, fear: 0 }) => ({ ready: true, personal, sourceClanId, targetClanId });
const unit = (partyId) => ({ partyId, level: 40, size: 1 });
const decide = (ab, ba, actor, peer, roll) => Policy.decide({ pressure: 3, actor, peer, actorPersona: persona, peerPersona: persona,
    towardPeer: ab, towardActor: ba, rng: () => roll });

// Groupable solo bots, one roll of 0.35: strangers do not offer, clanmates do.
assert.notStrictEqual(decide(relation(0, 0), relation(0, 0), unit(null), unit(null), 0.35).action, 'offer_party');
assert.strictEqual(decide(relation(7, 7), relation(7, 7), unit(null), unit(null), 0.35).action, 'offer_party', 'a clanmate is invited');
assert.notStrictEqual(decide(relation(7, 8), relation(8, 7), unit(null), unit(null), 0.35).action, 'offer_party', 'another clan is a stranger');

// Two parties (no grouping), one roll of 0.5: strangers dispute, clanmates tolerate.
assert.strictEqual(decide(relation(0, 0), relation(0, 0), unit('p1'), unit('p2'), 0.5).action, 'contest');
assert.strictEqual(decide(relation(7, 7), relation(7, 7), unit('p1'), unit('p2'), 0.5).action, 'yield', 'a clanmate is not disputed');

// A clanmate the bot really hates is still disputed.
const hated = { affinity: -20, trust: -20, hostility: 30, fear: 0 };
assert.strictEqual(decide(relation(7, 7, hated), relation(7, 7), unit('p1'), unit('p2'), 0.5).action, 'contest');
console.log('Clan competition clanmate checks passed');
