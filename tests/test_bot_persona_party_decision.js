const assert = require('assert');

require('../src/Global');

const Policy = invoke('GameServer/Bot/AI/PersonaPartyDecisionPolicy');

function subject(persona) {
    return { characterId: 1, persona };
}

const social = {
    primaryDrive: 'social',
    traits: { sociability: 0.80, empathy: 0.80, commitment: 0.70 }
};
const wealth = {
    primaryDrive: 'wealth',
    traits: { sociability: 0.30, empathy: 0.35, commitment: 0.45 }
};

const socialDecision = Policy.evaluate(subject(social), { trust: 0, familiarity: 0 });
assert.strictEqual(socialDecision.accept, true, 'a social persona should welcome a first party invite');

const soloDecision = Policy.evaluate(subject(wealth), { trust: 0, familiarity: 0 });
assert.strictEqual(soloDecision.accept, false, 'a reserved wealth-focused stranger should be allowed to prefer a solo run');
assert.strictEqual(soloDecision.reason, 'prefers_solo');

const knownPartnerDecision = Policy.evaluate(subject(wealth), { trust: 3, familiarity: 0 });
assert.strictEqual(knownPartnerDecision.accept, true, 'a known partner must override the solo preference');
// A known partner is a trusted or friendly relationship.
for (const [memory, accept] of [[{ trust: 0, familiarity: 5 }, true], [{ trust: 2, familiarity: 4 }, false],
    [{ trust: 8, familiarity: 0 }, true], [{ trust: -5, familiarity: 6 }, true], [{ trust: -5, familiarity: 0 }, false]]) {
    assert.strictEqual(Policy.evaluate(subject(wealth), memory).accept, accept, `known partner ${JSON.stringify(memory)}`);
}
assert(Policy.reply(soloDecision).includes('get to know'), 'a refusal should explain how the player can improve the relationship');

const hotFallback = Policy.evaluate({ actor: { fetchId: () => 42 } }, { trust: 0, familiarity: 0 });
assert.strictEqual(hotFallback.persona.characterId, 42, 'a newly spawned hot bot must use its actor id before async persona loading finishes');

console.log('Bot persona party decision checks passed');
