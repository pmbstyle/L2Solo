const assert = require('assert');

require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const BotPartyChat = invoke('GameServer/Bot/AI/BotPartyChat');

function actor(id, name) {
    return {
        fetchId: () => id,
        fetchName: () => name
    };
}

const originalPartySay = BotManager.botPartySay;
const originalTell = BotManager.botTell;
const messages = [];

try {
    BotManager.botPartySay = (_session, text) => {
        messages.push({ scope: 'party', text });
        return true;
    };
    BotManager.botTell = (_session, targetSession, text) => {
        messages.push({ scope: 'tell', target: targetSession.actor.fetchName(), text });
        return true;
    };

    const leaderSession = { actor: actor(1, 'Slava') };
    const companionSession = {
        actor: actor(2, 'Aria'),
        partyCompanion: true,
        followPlayerSession: leaderSession
    };

    assert.strictEqual(BotPartyChat.announce(companionSession, {
        priority: 'coordination', key: 'pull:100', text: 'Pulling Leto Lizardman.', now: 100_000
    }), true, 'the first coordination event should reach the party');
    assert.strictEqual(BotPartyChat.announce(companionSession, {
        priority: 'coordination', key: 'rebuff:1', text: 'Refresh Might.', now: 100_001
    }), false, 'the shared party budget should suppress a different coordination event immediately after a pull');
    assert.strictEqual(BotPartyChat.announce(companionSession, {
        priority: 'critical', key: 'add:200', text: 'Add on Slava.', now: 100_002
    }), true, 'a critical event must bypass ordinary party throttling');
    assert.strictEqual(BotPartyChat.announce(companionSession, {
        priority: 'critical', key: 'add:200', text: 'Add on Slava.', now: 101_000
    }), false, 'the same critical event should still be deduplicated');
    assert.strictEqual(BotPartyChat.announce(companionSession, {
        priority: 'coordination', key: 'rebuff:1', text: 'Refresh Might.', now: 107_002
    }), true, 'coordination should resume after the shared cooldown');

    const target = actor(3, 'Belen');
    const targetSession = { actor: target };
    const skill = {
        fetchSelfId: () => 1068,
        fetchName: () => 'Might'
    };
    assert.strictEqual(BotPartyChat.expectSkillResult(companionSession, {
        target,
        targetSession,
        skill,
        kind: 'support'
    }), true, 'a requested support cast should wait for a native result');
    assert.strictEqual(BotPartyChat.confirmSkillResult(companionSession, companionSession.actor, target, skill, {
        effect: { key: 'might' }
    }), true, 'only a landed effect may confirm the requested buff');
    assert.deepStrictEqual(messages.at(-1), {
        scope: 'tell', target: 'Belen', text: 'Might is up on Belen.'
    });

    assert.strictEqual(BotPartyChat.expectSkillResult(companionSession, {
        target,
        targetSession,
        skill,
        kind: 'support'
    }), true);
    assert.strictEqual(BotPartyChat.confirmSkillResult(companionSession, companionSession.actor, target, skill, {
        effect: null
    }), false, 'a rejected effect must not produce a false success confirmation');
    assert.strictEqual(messages.length, 4, 'failed casts must remain silent');
    assert.strictEqual(companionSession.pendingPartyChatResult, undefined, 'a completed but rejected cast must not remain eligible for a later confirmation');
    assert.strictEqual(BotPartyChat.confirmSkillResult(companionSession, companionSession.actor, target, skill, {
        effect: { key: 'might' }
    }), false, 'a later unrelated cast must not satisfy an already-failed request');

    const historyNow = Date.now() + BotPartyChat.EVENT_HISTORY_MS + 1;
    leaderSession.botPartyChat.events['expired:pull'] = historyNow - BotPartyChat.EVENT_HISTORY_MS - 1;
    assert.strictEqual(BotPartyChat.announce(companionSession, {
        priority: 'coordination', key: 'pull:101', text: 'Pulling Leto Lizardman Scout.', now: historyNow
    }), true, 'a new coordination event should still be sent after old history expires');
    assert.strictEqual(leaderSession.botPartyChat.events['expired:pull'], undefined, 'expired event history should be pruned instead of growing with every pull');

    const loneSession = { actor: actor(4, 'LoneHealer') };
    assert.strictEqual(BotPartyChat.expectSkillResult(loneSession, {
        target,
        targetSession,
        skill,
        kind: 'heal'
    }), true);
    assert.strictEqual(BotPartyChat.confirmSkillResult(loneSession, loneSession.actor, target, skill, {
        heal: 25
    }), true, 'a direct support confirmation should remain a tell outside a party');
    assert.deepStrictEqual(messages.at(-1), {
        scope: 'tell', target: 'Belen', text: 'Belen, Might landed.'
    });

    console.log('Bot party chat checks passed');
} finally {
    BotManager.botPartySay = originalPartySay;
    BotManager.botTell = originalTell;
}
