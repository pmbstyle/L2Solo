const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const Observer = invoke('WorldObserver/WorldObserverServer');
const PlayerActivitySignal = invoke('GameServer/Bot/Population/PlayerActivitySignal');

const originalUser = World.user;
try {
    PlayerActivitySignal.reset();
    World.user = { sessions: [] };
    assert.strictEqual(Observer.observerCacheTtl(1000), 2000,
        'idle observer snapshots may refresh frequently');

    const player = {
        accountId: 'observer_player',
        actor: { fetchIsOnline: () => true }
    };
    World.user.sessions = [player];
    assert.strictEqual(Observer.observerCacheTtl(2000), 5000,
        'a real player must increase observer snapshot reuse');

    const companion = {
        accountId: 'bot_observer_companion',
        actor: { fetchIsOnline: () => true },
        partyCompanion: true,
        followPlayerSession: player
    };
    World.user.sessions.push(companion);
    assert.strictEqual(Observer.observerCacheTtl(3000), 10000,
        'an active player party must maximize observer snapshot reuse');

    World.user.sessions = [];
    assert.strictEqual(Observer.observerCacheTtl(10000), 5000,
        'disconnect grace must keep the protected observer policy');
    assert.strictEqual(Observer.observerCacheTtl(40000), 2000,
        'observer policy must return to idle after the relog grace window');
} finally {
    World.user = originalUser;
    PlayerActivitySignal.reset();
}

console.log('World observer cache policy checks passed');
