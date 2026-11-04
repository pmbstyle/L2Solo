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
const originalNpcInfo = Response.npcInfo;
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

    const npc = { state: { fetchDead: () => false } };
    World.fetchNpcsInRadius = () => [npc];
    Response.npcInfo = () => {
        packetKinds.push({ kind: 'npcInfo' });
        return Buffer.from([0x16]);
    };
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
        'a bot source must only build visibility packets for the real player observer (no NpcInfo for its own discarded session)'
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
    assert.strictEqual(packetKinds.filter(({ kind }) => kind === 'npcInfo').length, 1, 'a real source sees the NPCs around it');
    assert.strictEqual(realSource.packets.length, 5, 'the real source must receive both visible-user snapshots and the NPC');
    assert.strictEqual(realObserver.packets.length, 4, 'the real observer must receive the moving player snapshot twice across refreshes');
    assert.strictEqual(botObserver.packetCount, 0, 'bot observers must remain packet-free for real sources too');
    assert.deepStrictEqual(wakeups, [], 'real movement must not fan out AI wakeups to every visible bot');

    botObserver.aiActive = true;
    botObserver.hotActorLod = { tier: 'preload' };
    updateEnvironment(botSource, sourceActor, { forceRefresh: true, immediateNpcInfo: true });
    assert.deepStrictEqual(wakeups, [], 'bot movement cannot wake dormant bots');
    updateEnvironment(realSource, realSourceActor, { forceRefresh: true, immediateNpcInfo: true });
    assert.deepStrictEqual(wakeups, [botObserver], 'a real arrival wakes preload AI without waiting 30 seconds');
    botObserver.hotActorLod.tier = 'visible';
    updateEnvironment(realSource, realSourceActor, { forceRefresh: true, immediateNpcInfo: true });
    assert.deepStrictEqual(wakeups, [botObserver], 'active visible AI keeps its regular cadence');
    botObserver.hotActorLod.tier = 'preload';
    botObserver.aiActive = false;
    updateEnvironment(realSource, realSourceActor, { forceRefresh: true, immediateNpcInfo: true });
    assert.deepStrictEqual(wakeups, [botObserver], 'an arrival cannot restart stopped AI');
} finally {
    World.fetchNpcsInRadius = originalFetchNpcsInRadius;
    World.fetchVisibleUsers = originalFetchVisibleUsers;
    World.fetchVisibleRealPlayers = originalFetchVisibleRealPlayers;
    Response.charInfo = originalCharInfo;
    Response.relationChanged = originalRelationChanged;
    Response.npcInfo = originalNpcInfo;
    BotAI.wakeup = originalBotWakeup;
    NpcAggro.engageNearby = originalNpcEngage;
    TownGuard.engageNearby = originalGuardEngage;
}

console.log('Update environment visibility checks passed');
