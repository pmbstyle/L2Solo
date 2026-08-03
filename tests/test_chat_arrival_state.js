const assert = require('assert');

require('../src/Global');

const ChatArrivalState = invoke('GameServer/Bot/AI/ChatArrivalState');

function actor(id, x = 0) {
    return {
        fetchId: () => id,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false,
        state: { inMotion: () => false },
        unselect() {}
    };
}

try {
    const target = { actor: actor(9501, 0) };
    const session = { actor: actor(9502, 100), aiActive: true };
    ChatArrivalState.start(session, target, {
        reason: 'player_chat_follow',
        persistent: true,
        stopOnArrival: true
    });
    assert.strictEqual(session.chatArrivalPersistent, true);
    assert.strictEqual(session.chatArrivalUntil, 0);
    assert.strictEqual(ChatArrivalState.tick(session, session.actor), false, 'arrival should clear after reaching the player');
    assert.strictEqual(session.chatArrivalActive, false);
    console.log('Chat arrival state checks passed');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
