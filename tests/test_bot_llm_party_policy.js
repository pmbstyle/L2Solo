const assert = require('assert');

require('../src/Global');

const BotBrain = invoke('GameServer/Bot/AI/BotBrain');

function actor(id, name) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLevel: () => 20,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false
    };
}

function decision() {
    return {
        action: 'say',
        reply: 'Sure, I would love to join your party.',
        reason: 'model_positive',
        confidence: 0.95
    };
}

function main() {
    const playerSession = { accountId: 'party_player', actor: actor(9101, 'PartyPlayer') };
    const soloSession = {
        accountId: 'bot_solo_party',
        actor: actor(9102, 'SoloBot'),
        persona: {
            primaryDrive: 'wealth',
            traits: { sociability: 0.1, empathy: 0, commitment: 0 }
        }
    };
    const solo = BotBrain.applyPartyPolicy(soloSession, decision(), { playerSession }, 'wanna party?');
    assert.strictEqual(solo.action, 'say');
    assert.match(solo.reply, /cannot join right now/i);
    assert.match(solo.reason, /^party_policy:/);

    const socialSession = {
        accountId: 'bot_social_party',
        actor: actor(9103, 'SocialBot'),
        persona: {
            primaryDrive: 'social',
            traits: { sociability: 0.95, empathy: 0.8, commitment: 0.8 }
        }
    };
    const social = BotBrain.applyPartyPolicy(socialSession, decision(), { playerSession }, 'join our group');
    assert.match(social.reply, /send me an invite/i);
    assert.strictEqual(social.reason, 'party_policy:available');
    console.log('LLM party policy checks passed');
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
