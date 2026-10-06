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
assert(socialDecision.probability > 0.5, 'a social stranger welcomes party invites more often');
const soloDecision = Policy.evaluate(subject(wealth), { trust: 0, familiarity: 0 });
assert(soloDecision.probability < 0.5, 'a reserved wealth stranger prefers solo more often');
for (const options of [{}, { peer: { characterId: 2, stats: {}, inventory: {} } }]) {
    const stranger = Policy.evaluate(subject(wealth), { trust: 3, familiarity: 0, groupRuns: 0 }, options);
    const partner = Policy.evaluate(subject(wealth), { trust: 3, familiarity: 0, groupRuns: 1 }, options);
    assert(Math.abs(partner.probability - Math.min(0.98, stranger.probability + wealth.traits.commitment / 4)) < 1e-12);
    const inviteOnly = Policy.evaluate(subject(wealth), { familiarity: 6, groupRuns: 0 }, options);
    const formed = Policy.evaluate(subject(wealth), { familiarity: 6, groupRuns: 1 }, options);
    assert(Math.abs(formed.probability - Math.min(0.98, inviteOnly.probability + wealth.traits.commitment / 4)) < 1e-12);
    const first = Policy.evaluate(subject(wealth), { inviteAttempts: 1, playerId: 2 }, options);
    const second = Policy.evaluate(subject(wealth), { inviteAttempts: 2, playerId: 2 }, options);
    assert.notStrictEqual(first.roll, second.roll, 'the next invite has a new deterministic roll');
    assert.strictEqual(first.roll, Policy.evaluate(subject(wealth), { inviteAttempts: 1, playerId: 2 }, options).roll);
}
assert(Policy.reply({ ...soloDecision, accept: false }).includes('get to know'));

// A hot bot is known by its actor id: it answers with its stored persona,
// never a regenerated one; without a stored persona it is simply available.
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const unknown = Policy.evaluate({ actor: { fetchId: () => 42 } }, { trust: 0, familiarity: 0 });
assert.strictEqual(unknown.persona, null, 'no persona is generated for a bot without a stored one');
assert.strictEqual(unknown.accept, true);
const stored = { ...BotPersona.generate({ characterId: 42 }), primaryDrive: 'wealth', traits: { ...wealth.traits } };
BotPersona.useRowSource((id) => (id === 42 ? BotPersona.tableRow(stored) : null));
const hot = Policy.evaluate({ actor: { fetchId: () => 42 } }, { trust: 0, familiarity: 0 });
assert.strictEqual(hot.persona.characterId, 42, 'a hot bot uses its actor id to find its stored persona');
assert(hot.probability < 0.5, 'the stored reserved wealth persona decides');
BotPersona.reset();

console.log('Bot persona party decision checks passed');
