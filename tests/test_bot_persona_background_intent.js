const assert = require('assert');

require('../src/Global');

const PersonaPartyPolicy = invoke('GameServer/Bot/Population/PersonaPartyPolicy');

function state(persona, extras = {}) {
    return { characterId: 1, persona, stats: {}, ...extras };
}

const social = {
    primaryDrive: 'social',
    archetype: 'party_regular',
    traits: { sociability: 0.80, commitment: 0.70, empathy: 0.70 }
};
const soloWealth = {
    primaryDrive: 'wealth',
    archetype: 'pragmatic_earner',
    traits: { sociability: 0.30, commitment: 0.40, empathy: 0.35 }
};

assert.strictEqual(PersonaPartyPolicy.backgroundIntent(state(social)).accept, true, 'a social bot should volunteer for background parties');
assert.strictEqual(PersonaPartyPolicy.backgroundIntent(state(soloWealth)).accept, false, 'a reserved wealth bot should stay solo by default');
assert.strictEqual(
    PersonaPartyPolicy.backgroundIntent(state(soloWealth, { activity: 'party_wait' })).reason,
    'goal_requires_party',
    'a goal that requires a party must override the solo preference'
);
assert.strictEqual(
    PersonaPartyPolicy.backgroundIntent(state(soloWealth, { stats: { partyHistory: { 2: { runs: 3 } } } })).reason,
    'established_party_bonds',
    'proven background bonds must override the solo preference'
);

console.log('Bot persona background intent checks passed');
