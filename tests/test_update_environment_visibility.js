const assert = require('assert');

require('../src/Global');

const updateEnvironment = invoke('GameServer/Actor/Generics/UpdateEnvironment');
const World = invoke('GameServer/World/World');
const Response = invoke('GameServer/Network/Response');
const BotAI = invoke('GameServer/Bot/BotAI');
const NpcAggro = invoke('GameServer/Npc/NpcAggro');
const TownGuard = invoke('GameServer/Npc/TownGuard');
const BotSession = invoke('GameServer/Bot/BotSession');

class RealSession {
    constructor(accountId) {
        this.accountId = accountId;
        this.packets = [];
    }

    dataSendToMe(packet) {
        this.packets.push(packet);
    }
}

function actorAt(x, y) {
    return {
        previousXY: null,
        fetchLocX: () => x,
        fetchLocY: () => y,
        fetchPrivateStoreType: () => 0,
        fetchPrivateStore: () => null,
        fetchTitle: () => '',
        state: { fetchDead: () => false }
    };
}

const originalFetchNpcsInRadius = World.fetchNpcsInRadius;
const originalFetchVisibleUsers = World.fetchVisibleUsers;
const originalFetchVisibleRealPlayers = World.fetchVisibleRealPlayers;
const originalCharInfo = Response.charInfo;
const originalRelationChanged = Response.relationChanged;
const originalBotWakeup = BotAI.wakeup;
const originalNpcEngage = NpcAggro.engageNearby;
const originalGuardEngage = TownGuard.engageNearby;

try {
    const packetKinds = [];
    const wakeups = [];
    const botSource = new BotSession('bot_source');
    const botObserver = new BotSession('bot_observer');
    const realObserver = new RealSession('player_observer');
    const sourceActor = actorAt(100, 100);
    botSource.actor = sourceActor;
    botObserver.actor = actorAt(200, 100);
    botObserver.packetCount = 0;
    botObserver.dataSendToMe = () => { botObserver.packetCount += 1; };
    realObserver.actor = actorAt(300, 100);

    World.fetchNpcsInRadius = () => [];
    World.fetchVisibleUsers = () => [botObserver, realObserver];
    World.fetchVisibleRealPlayers = () => [realObserver];
    Response.charInfo = (actor) => {
        packetKinds.push({ kind: 'charInfo', actor });
        return Buffer.from([0x03]);
    };
    Response.relationChanged = (actor) => {
        packetKinds.push({ kind: 'relationChanged', actor });
        return Buffer.from([0xCE]);
    };
    BotAI.wakeup = (session) => wakeups.push(session);
    NpcAggro.engageNearby = () => {};
    TownGuard.engageNearby = () => {};

    updateEnvironment(botSource, sourceActor, {
        forceRefresh: true,
        immediateNpcInfo: true
    });

    assert.deepStrictEqual(
        packetKinds.map(({ kind }) => kind),
        ['charInfo', 'relationChanged'],
        'a bot source must only build visibility packets for the real player observer'
    );
    assert.strictEqual(realObserver.packets.length, 2, 'the real observer must receive the moving bot snapshot');
    assert.strictEqual(botObserver.packetCount, 0, 'bot observers must not receive discarded visibility packets');
    assert.deepStrictEqual(wakeups, [], 'bot-source visibility refresh must not fan out AI wakeups');

    packetKinds.length = 0;
    wakeups.length = 0;
    const realSource = new RealSession('player_source');
    const realSourceActor = actorAt(100, 100);
    realSource.actor = realSourceActor;

    updateEnvironment(realSource, realSourceActor, {
        forceRefresh: true,
        immediateNpcInfo: true
    });

    assert.strictEqual(
        packetKinds.filter(({ kind }) => kind === 'charInfo').length,
        3,
        'a real source must build snapshots for both visible users and the real observer'
    );
    assert.strictEqual(realSource.packets.length, 4, 'the real source must receive both visible-user snapshots');
    assert.strictEqual(realObserver.packets.length, 4, 'the real observer must receive the moving player snapshot twice across refreshes');
    assert.strictEqual(botObserver.packetCount, 0, 'bot observers must remain packet-free for real sources too');
    assert.deepStrictEqual(wakeups, [], 'real movement must not fan out AI wakeups to every visible bot');
} finally {
    World.fetchNpcsInRadius = originalFetchNpcsInRadius;
    World.fetchVisibleUsers = originalFetchVisibleUsers;
    World.fetchVisibleRealPlayers = originalFetchVisibleRealPlayers;
    Response.charInfo = originalCharInfo;
    Response.relationChanged = originalRelationChanged;
    BotAI.wakeup = originalBotWakeup;
    NpcAggro.engageNearby = originalNpcEngage;
    TownGuard.engageNearby = originalGuardEngage;
}

console.log('Update environment visibility checks passed');
