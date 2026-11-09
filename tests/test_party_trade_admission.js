'use strict';
const assert = require('node:assert/strict');
const { partyTradeAllowed, personalOfferAllowed, configureTradeAdmission } = require('../src/GameServer/Bot/Population/PartyAdmission');
for (const phase of ['hot', 'cold']) {
    const solo = { phase, stats: {} };
    assert(partyTradeAllowed('party', solo));
    assert(partyTradeAllowed('trade', solo));
    assert(!partyTradeAllowed('party', solo, null, true));
    assert(!partyTradeAllowed('party', solo, null, false, true));
    assert(!partyTradeAllowed('party', { ...solo, stats: { tradeMeeting: [1, 2] } }));
    for (const grouped of [{ ...solo, partyId: 'native' }, { ...solo, party: { partyId: 'projected' } }, { ...solo, stats: { playerPartyTakeover: { playerId: 9 } } }]) {
        assert(!partyTradeAllowed('trade', grouped));
        assert(!personalOfferAllowed({ conditional: true }, solo, grouped));
        assert(!personalOfferAllowed({ conditional: true }, grouped, solo));
        assert(personalOfferAllowed({ custodyPolicy: 0 }, grouped, grouped), 'backed shops remain available');
        assert(personalOfferAllowed({ sourceType: 'npc' }, grouped, grouped), 'NPC production/cleanup is not personal trade');
    }
    // A side with an accepted meeting meets only at that meeting.
    const giran = { phase, stats: { tradeMeeting: [1, 2, 'Giran', 1, 2, 3] } };
    assert(personalOfferAllowed({ custodyPolicy: 1, town: 'Giran' }, solo, giran), 'a seller anchored in this town meets here');
    assert(!personalOfferAllowed({ custodyPolicy: 1, town: 'Dion' }, giran, solo), 'a buyer anchored elsewhere cannot');

    for (const session of [{ partyCompanion: true }, { followPlayerSession: {} }, { hotBackgroundPartyId: 'runtime' }]) {
        assert(!partyTradeAllowed('trade', solo, session));
        assert(!personalOfferAllowed({ custodyPolicy: 1 }, solo, solo, null, session));
    }
}
// A player has no life state: the worker reads its published anchor.
configureTradeAdmission(() => undefined, () => null, id => id === 9 ? { town: 'Giran', locX: 1, locY: 2, locZ: 3 } : null);
assert(!personalOfferAllowed({ custodyPolicy: 1, town: 'Dion', ownerId: 9 }, { phase: 'cold', stats: {} }),
    'a player waiting at a meeting in another town is not offered');
assert(personalOfferAllowed({ custodyPolicy: 1, town: 'Giran', ownerId: 9 }, { phase: 'cold', stats: {} }));
assert.throws(() => partyTradeAllowed('unknown'), /invalid_party_trade_direction/);
console.log('Shared party/personal-trade admission: hot/cold, preparation, native/runtime membership and NPC/backed exceptions passed');
