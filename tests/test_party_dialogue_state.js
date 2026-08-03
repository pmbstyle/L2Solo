const assert = require('assert');

require('../src/Global');

const PartyDialogueState = invoke('GameServer/Bot/AI/PartyDialogueState');

function session(id, name) {
    return { actor: { fetchId: () => id, fetchName: () => name } };
}

async function main() {
    const player = { actor: { fetchId: () => 100, fetchName: () => 'Slava' } };
    const nice = session(1, 'NiceBot');
    const healer = session(2, 'Healer');

    PartyDialogueState.beginRequest(player, nice, {
        reason: 'explicit_unique_prefix',
        text: 'Nice, pull now.',
        channel: 'party_chat',
        at: 1000
    });
    let state = PartyDialogueState.snapshot(player);
    assert.strictEqual(state.inFlightBotId, 1);
    assert.strictEqual(state.activeBotId, null, 'request admission must not claim a delivered reply');
    assert.strictEqual(state.recentTurns.length, 1);

    PartyDialogueState.beginRequest(player, healer, {
        reason: 'active_responder',
        text: 'yes',
        channel: 'party_chat',
        at: 1100
    });
    state = PartyDialogueState.snapshot(player);
    assert.strictEqual(state.inFlightBotId, 2, 'rapid continuation must move the in-flight owner immediately');
    assert.strictEqual(state.activeBotId, null);

    PartyDialogueState.recordDeliveredReply(player, nice, 'I am on pull.', {
        turnId: 'turn-1',
        channel: 'party_chat',
        at: 1150
    });
    state = PartyDialogueState.snapshot(player);
    assert.strictEqual(state.inFlightBotId, 2, 'an older bot reply must not steal a newer in-flight owner');

    PartyDialogueState.clearInFlight(player, healer);
    state = PartyDialogueState.snapshot(player);
    assert.strictEqual(state.inFlightBotId, null);

    PartyDialogueState.recordDeliveredReply(player, nice, 'I am on pull.', {
        turnId: 'turn-1',
        channel: 'party_chat',
        at: 1200
    });
    state = PartyDialogueState.snapshot(player);
    assert.strictEqual(state.activeBotId, 1);
    assert.strictEqual(state.lastDeliveredBotId, 1);
    assert.strictEqual(state.inFlightBotId, null);
    assert.strictEqual(state.recentTurns.at(-1).role, 'bot');

    PartyDialogueState.recordDeliveredReply(player, nice, 'I am on pull.', {
        turnId: 'turn-1',
        channel: 'party_chat',
        at: 1300
    });
    assert.strictEqual(PartyDialogueState.snapshot(player).recentTurns.length, 3, 'same delivery must be idempotent');

    const bounded = PartyDialogueState.ensure(player);
    for (let index = 0; index < 20; index += 1) {
        PartyDialogueState.beginRequest(player, nice, { text: `message ${index}`, at: 2000 + index });
    }
    assert.ok(bounded.recentTurns.length <= PartyDialogueState.MAX_RECENT_TURNS);

    PartyDialogueState.reset(player);
    assert.strictEqual(PartyDialogueState.snapshot(player), null);
    console.log('Party dialogue state checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
