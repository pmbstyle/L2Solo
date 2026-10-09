'use strict';
const assert = require('node:assert/strict');
const { partyTradeAllowed, personalOfferAllowed } = require('../src/GameServer/Bot/Population/PartyAdmission');
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
    for (const session of [{ partyCompanion: true }, { followPlayerSession: {} }, { hotBackgroundPartyId: 'runtime' }]) {
        assert(!partyTradeAllowed('trade', solo, session));
        assert(!personalOfferAllowed({ custodyPolicy: 1 }, solo, solo, null, session));
    }
}
assert.throws(() => partyTradeAllowed('unknown'), /invalid_party_trade_direction/);
console.log('Shared party/personal-trade admission: hot/cold, preparation, native/runtime membership and NPC/backed exceptions passed');
