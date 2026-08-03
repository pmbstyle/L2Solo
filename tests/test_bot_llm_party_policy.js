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
    assert.strictEqual(BotBrain.isPartyCandidateRequest('do you know anybody to join our party?'), true);
    assert.strictEqual(BotBrain.isPartyRequest('do you know anybody to join our party?'), false);
    assert.strictEqual(BotBrain.isPartyCandidateRequest('I meant other bots'), true);
    assert.strictEqual(BotBrain.isPartyRequest('I meant other bots'), false);
    assert.strictEqual(BotBrain.isPartyCandidateRequest('who can join our group?'), true);
    assert.strictEqual(BotBrain.isPartyCandidateRequest('кто может вступить в пати?'), true);
    assert.strictEqual(BotBrain.isPartyRequest('can I join your party?'), true);

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
    assert.strictEqual(social.reply, decision().reply, 'available party policy must preserve the model personality');
    assert.strictEqual(social.reason, 'party_policy:available');

    const companionSession = {
        ...socialSession,
        partyCompanion: true,
        followPlayerSession: playerSession
    };
    const candidate = BotBrain.applyPartyPolicy(
        companionSession,
        decision(),
        { playerSession },
        'do you know anybody to join our party?'
    );
    assert.strictEqual(candidate.reply, decision().reply, 'candidate discovery must remain an LLM reply');
    assert.notStrictEqual(candidate.reason, 'party_policy:already_grouped');
    console.log('LLM party policy checks passed');
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
