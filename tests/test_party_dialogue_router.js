const assert = require('assert');

require('../src/Global');

const PartyDialogueRouter = invoke('GameServer/Bot/AI/PartyDialogueRouter');

function actor(id, name, x = 0) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchIsOnline: () => true,
        fetchDestId: () => 0
    };
}

function session(id, name, x = 0, companion = true, role = null) {
    const value = {
        actor: actor(id, name, x),
        partyCompanion: companion,
        followPlayerSession: null,
        role
    };
    return value;
}

async function main() {
    const player = { actor: actor(100, 'Slava', 0) };
    const nice = session(1, 'NiceBot', 5000);
    const healer = session(2, 'Mira', 100, true, 'healer');
    const unrelated = session(3, 'FarBot', 0, false);
    nice.followPlayerSession = player;
    healer.followPlayerSession = player;

    let result = PartyDialogueRouter.select({
        text: 'Nice, now you are on pull.',
        playerSession: player,
        sessions: [nice, healer, unrelated],
        kind: 3
    });
    assert.strictEqual(result.reason, 'explicit_unique_prefix');
    assert.strictEqual(result.candidate.session, nice);
    assert.deepStrictEqual(result.candidates.map((candidate) => candidate.session), [nice, healer]);

    result = PartyDialogueRouter.select({
        text: 'NiceBot, open the trade.',
        playerSession: player,
        sessions: [nice, healer],
        kind: 3,
        activeResponderId: healer.actor.fetchId(),
        activeResponderAt: Date.now()
    });
    assert.strictEqual(result.reason, 'explicit_full_name', 'explicit name must beat the previous responder');
    assert.strictEqual(result.candidate.session, nice);

    result = PartyDialogueRouter.select({
        text: 'yes, continue.',
        playerSession: player,
        sessions: [nice, healer],
        kind: 3,
        activeResponderId: healer.actor.fetchId(),
        activeResponderAt: Date.now()
    });
    assert.strictEqual(result.reason, 'active_responder');
    assert.strictEqual(result.candidate.session, healer);

    nice.activeTrade = { playerSession: player };
    result = PartyDialogueRouter.select({
        text: 'is the price ready?',
        playerSession: player,
        sessions: [nice, healer],
        kind: 3
    });
    assert.strictEqual(result.reason, 'pending_interaction');
    assert.strictEqual(result.candidate.session, nice);
    delete nice.activeTrade;

    result = PartyDialogueRouter.select({
        text: 'healer, keep us alive.',
        playerSession: player,
        sessions: [nice, healer],
        kind: 3
    });
    assert.strictEqual(result.reason, 'role_healer');
    assert.strictEqual(result.candidate.session, healer);

    const arina = session(4, 'Arina');
    const arinor = session(5, 'Arinor');
    arina.followPlayerSession = player;
    arinor.followPlayerSession = player;
    result = PartyDialogueRouter.select({
        text: 'Arin, regroup.',
        playerSession: player,
        sessions: [arina, arinor],
        kind: 3,
        allowSpokespersonFallback: true
    });
    assert.strictEqual(result.reason, 'party_spokesperson_ambiguous');
    assert.strictEqual(result.candidate.actor.fetchName(), 'Arina');

    result = PartyDialogueRouter.select({
        text: 'party, regroup.',
        playerSession: player,
        sessions: [nice, healer],
        kind: 3,
        activeResponderAt: Date.now() - PartyDialogueRouter.ACTIVE_RESPONDER_TTL_MS - 1
    });
    assert.strictEqual(result.reason, 'party_spokesperson');
    assert.strictEqual(result.candidate.session, nice);

    result = PartyDialogueRouter.select({
        text: 'the weather is nice today',
        playerSession: player,
        sessions: [nice, healer],
        kind: 0
    });
    assert.strictEqual(result.status, 'none');

    console.log('Party dialogue router checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
