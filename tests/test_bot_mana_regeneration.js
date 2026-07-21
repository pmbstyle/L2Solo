const assert = require('assert');

require('../src/Global');

const RestingState = invoke('GameServer/Bot/AI/States/RestingState');

let seated = true;
let casts = 0;
const manaRegeneration = {
    fetchPassive: () => false,
    fetchSemantic: () => ({ effect: 'mana_regeneration' }),
    fetchTargetKind: () => 'self',
    fetchConsumedMp: () => 12,
    fetchSelfId: () => 1047
};
const bot = {
    effects: {},
    fetchId: () => 17,
    fetchHp: () => 800,
    fetchMaxHp: () => 1000,
    fetchMp: () => 20,
    fetchMaxMp: () => 200,
    fetchLocX: () => 0,
    fetchLocY: () => 0,
    fetchLocZ: () => 0,
    state: {
        fetchSeated: () => seated,
        setSeated: (value) => { seated = value; },
        fetchCasts: () => false
    },
    skillset: { fetchSkills: () => [manaRegeneration] }
};
const session = {
    dataSendToOthers: () => {},
    roleDecision: null
};
const Generics = {
    skillExec: (_session, actor, data) => {
        casts += 1;
        assert.strictEqual(actor, bot);
        assert.deepStrictEqual(data, { id: 17, selfId: 1047, ctrl: false });
    }
};

assert.strictEqual(RestingState.maybeCastManaRegeneration(session, bot, Generics), true, 'a resting bot with Mana Regeneration should cast it for low MP');
assert.strictEqual(casts, 1);
assert.strictEqual(seated, false, 'the bot must stand before the native self-cast');
assert.strictEqual(session.roleDecision.action, 'cast_mana_regeneration');
assert.strictEqual(RestingState.maybeCastManaRegeneration(session, bot, Generics), false, 'the cast retry guard must prevent spam while the skill is pending');

let seatedDuringCast = false;
const castingBot = {
    ...bot,
    state: {
        fetchSeated: () => seatedDuringCast,
        setSeated: (value) => { seatedDuringCast = value; },
        fetchCasts: () => true
    }
};
RestingState.tick(
    { dataSendToOthers: () => {} },
    castingBot,
    { skillExec: () => assert.fail('a live cast must not start another Mana Regeneration action') },
    { say: () => assert.fail('a casting bot must not leave recovery') }
);
assert.strictEqual(seatedDuringCast, false, 'a bot must remain standing while Mana Regeneration is casting');

console.log('Bot Mana Regeneration checks passed');
