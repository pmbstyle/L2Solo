const assert = require('assert');

require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');

function fakeActor(id, name, options = {}) {
    const actor = {
        id,
        name,
        hp: options.hp ?? 100,
        maxHp: options.maxHp ?? 100,
        mp: options.mp ?? 100,
        maxMp: options.maxMp ?? 100,
        classId: options.classId ?? 0,
        locX: options.locX ?? 0,
        locY: options.locY ?? 0,
        locZ: options.locZ ?? 0,
        moveCalls: [],
        vitalUpdates: 0,
        fetchId() { return this.id; },
        fetchName() { return this.name; },
        fetchClassId() { return this.classId; },
        fetchLocX() { return this.locX; },
        fetchLocY() { return this.locY; },
        fetchLocZ() { return this.locZ; },
        fetchHp() { return this.hp; },
        fetchMaxHp() { return this.maxHp; },
        fetchMp() { return this.mp; },
        fetchMaxMp() { return this.maxMp; },
        setHp(value) { this.hp = value; },
        setMp(value) { this.mp = value; },
        fetchIsOnline() { return true; },
        isDead() { return false; },
        statusUpdateVitals() { this.vitalUpdates += 1; },
        moveTo(data) { this.moveCalls.push(data); }
    };
    return actor;
}

function fakeSession(accountId, actor) {
    return {
        accountId,
        actor,
        selfPackets: 0,
        dataSendToMe() { this.selfPackets += 1; },
        dataSendToOthers() {}
    };
}

const originalSessions = BotManager.sessions;
const originalSetTimeout = global.setTimeout;

try {
    global.setTimeout = (fn) => {
        fn();
        return 0;
    };

    const player = fakeActor(2000001, 'Slava', { hp: 20, mp: 7 });
    const playerSession = fakeSession('player_test', player);
    const followBot = fakeActor(2000002, 'FollowBot', { locX: 100 });
    const bystanderBot = fakeActor(2000003, 'BystanderBot', { locX: 120 });
    const followSession = fakeSession('bot_follow', followBot);
    const bystanderSession = fakeSession('bot_bystander', bystanderBot);

    BotManager.sessions = [followSession, bystanderSession];
    BotManager.handlePlayerSpeak(playerSession, { text: 'follow me' });

    assert.strictEqual(followBot.moveCalls.length, 0, 'untargeted follow command should not move nearby bots');
    assert.strictEqual(bystanderBot.moveCalls.length, 0, 'untargeted follow command should not move bystanders');

    player.fetchDestId = () => followBot.fetchId();
    BotManager.handlePlayerSpeak(playerSession, { text: 'follow me' });

    assert.strictEqual(followBot.moveCalls.length, 1, 'selected bot should obey direct follow command');
    assert.strictEqual(bystanderBot.moveCalls.length, 0, 'direct follow command should not spill to other nearby bots');

    const healer = fakeActor(2000004, 'HealerBot', { classId: 15, mp: 30, locX: 100 });
    const healerSession = fakeSession('bot_healer', healer);
    BotManager.sessions = [healerSession];
    player.fetchDestId = () => healer.fetchId();

    BotManager.handlePlayerSpeak(playerSession, { text: 'heal me' });

    assert.strictEqual(player.fetchHp(), player.fetchMaxHp(), 'direct healer support should heal HP');
    assert.strictEqual(player.fetchMp(), 7, 'direct healer support must not restore player MP for free');
    assert.strictEqual(healer.fetchMp(), 15, 'direct healer support should consume healer MP');
    assert(player.vitalUpdates > 0, 'player vitals should refresh after direct heal');
    assert(healer.vitalUpdates > 0, 'healer vitals should refresh after MP cost');

    console.log('Bot chat command checks passed');
} finally {
    BotManager.sessions = originalSessions;
    global.setTimeout = originalSetTimeout;
}
