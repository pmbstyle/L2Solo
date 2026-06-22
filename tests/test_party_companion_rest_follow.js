const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const FollowingState = invoke('GameServer/Bot/AI/States/FollowingState');
const HuntingState = invoke('GameServer/Bot/AI/States/HuntingState');
const RestingState = invoke('GameServer/Bot/AI/States/RestingState');
const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');

class FakeState {
    constructor() {
        this.seated = false;
        this.dead = false;
        this.towards = false;
        this.hits = false;
        this.casts = false;
        this.animated = false;
    }

    fetchSeated() { return this.seated; }
    setSeated(value) { this.seated = value; }
    fetchDead() { return this.dead; }
    fetchTowards() { return this.towards; }
    setTowards(value) { this.towards = value; }
    fetchHits() { return this.hits; }
    fetchCasts() { return this.casts; }
    fetchAnimated() { return this.animated; }
    fetchPickinUp() { return false; }
    isBlocked() { return this.hits || this.casts || this.animated || this.seated; }
}

function fakeActor(id, loc = {}) {
    const actor = {
        id,
        name: `actor_${id}`,
        locX: loc.locX || 0,
        locY: loc.locY || 0,
        locZ: loc.locZ || 0,
        hp: loc.hp || 100,
        maxHp: loc.maxHp || 100,
        mp: loc.mp || 100,
        maxMp: loc.maxMp || 100,
        classId: loc.classId || 0,
        level: loc.level || 26,
        karma: loc.karma || 0,
        pvpFlag: loc.pvpFlag || 0,
        destId: loc.destId,
        state: new FakeState(),
        activeBuffs: {
            windWalk: Date.now() + 600000,
            shield: Date.now() + 600000,
            haste: Date.now() + 600000,
            might: Date.now() + 600000
        },
        moves: [],
        fetchId() { return this.id; },
        fetchName() { return this.name; },
        fetchLocX() { return this.locX; },
        fetchLocY() { return this.locY; },
        fetchLocZ() { return this.locZ; },
        fetchHp() { return this.hp; },
        fetchMaxHp() { return this.maxHp; },
        fetchMp() { return this.mp; },
        fetchMaxMp() { return this.maxMp; },
        fetchClassId() { return this.classId; },
        fetchLevel() { return this.level; },
        fetchKarma() { return this.karma; },
        fetchPvpFlag() { return this.pvpFlag; },
        fetchDestId() { return this.destId; },
        fetchIsOnline() { return true; },
        isDead() { return this.state.fetchDead(); },
        isBlocked() { return this.state.isBlocked(); },
        moveTo(data) { this.moves.push(data); },
        select(data) { this.destId = data.id; },
        unselect() { this.destId = undefined; },
        statusUpdateVitals() {},
        skillset: { fetchSkill: () => null },
        automation: { abortAll() {}, replenishVitals() {} }
    };
    return actor;
}

function fakeSession(accountId, actor) {
    return {
        accountId,
        actor,
        sent: 0,
        dataSendToMe() { this.sent++; },
        dataSendToOthers() { this.sent++; },
        dataSendToMeAndOthers() { this.sent++; }
    };
}

const originalUsers = World.user;
const originalFetchUser = World.fetchUser;
const originalFetchNpc = World.fetchNpc;
const originalFetchNpcsInRadius = World.fetchNpcsInRadius;
const originalRandom = Math.random;

try {
    Math.random = () => 1;

    const leader = fakeActor(2000001, { locX: 0, locY: 0 });
    const leaderSession = fakeSession('player_test', leader);
    const bot = fakeActor(2000002, { locX: 1200, locY: 0 });
    const botSession = fakeSession('bot_test', bot);
    botSession.followPlayerSession = leaderSession;
    botSession.partyCompanion = true;
    botSession.plan = 'following';
    World.user = { sessions: [leaderSession, botSession] };
    World.fetchNpcsInRadius = () => [];

    FollowingState.tick(botSession, bot, {}, { say() {}, executeCombat() {}, executePvPCombat() {} });

    assert.strictEqual(bot.moves.length, 1, 'companion should run after the leader at 1200 range');
    assert.strictEqual(bot.fetchLocX(), 1200, 'companion should not teleport at 1200 range');

    const restingBot = fakeActor(2000003, { locX: 0, locY: 0 });
    restingBot.state.setSeated(true);
    const restingSession = fakeSession('bot_resting', restingBot);
    restingSession.followPlayerSession = leaderSession;
    restingSession.partyCompanion = true;
    restingSession.plan = 'resting';
    World.user = { sessions: [leaderSession, restingSession] };
    World.fetchNpcsInRadius = () => [{
        fetchId: () => 1001,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => leader.fetchId(),
        fetchLocX: () => 50,
        fetchLocY: () => 0
    }];

    RestingState.tick(restingSession, restingBot, {}, { say() {} });

    assert.strictEqual(restingSession.plan, 'following', 'resting companion should wake when party is attacked');
    assert.strictEqual(restingBot.state.fetchSeated(), false, 'resting companion should stand before assisting');
    assert.strictEqual(restingSession.currentTargetId, 1001, 'resting companion should remember the threat target');

    leader.destId = 1003;
    const assistingBot = fakeActor(2000006, { locX: 500, locY: 0 });
    const assistingSession = fakeSession('bot_assisting', assistingBot);
    assistingSession.followPlayerSession = leaderSession;
    assistingSession.partyCompanion = true;
    assistingSession.plan = 'following';
    World.user = { sessions: [leaderSession, assistingSession] };
    World.fetchNpcsInRadius = () => [];
    World.fetchUser = () => ({
        then: () => ({
            catch: (handler) => {
                handler();
            }
        })
    });
    World.fetchNpc = () => ({
        then: (handler) => {
            handler({
                fetchId: () => 1003,
                fetchAttackable: () => true,
                isDead: () => false,
                fetchLocX: () => 800,
                fetchLocY: () => 0,
                fetchLocZ: () => 0,
                fetchName: () => 'next mob'
            });
            return { catch() {} };
        }
    });

    FollowingState.tick(assistingSession, assistingBot, {}, {
        say() {},
        executeCombat() {},
        executePvPCombat() {}
    });

    assert.strictEqual(assistingBot.moves.length, 0, 'companion should not run back to leader while leader has a next target');
    assert.strictEqual(assistingSession.currentTargetId, 1003, 'companion should switch directly to the leader target');

    Math.random = () => 0;
    const huntingCompanion = fakeActor(2000004, { locX: 0, locY: 0 });
    const huntingSession = fakeSession('bot_hunting_companion', huntingCompanion);
    huntingSession.followPlayerSession = leaderSession;
    huntingSession.partyCompanion = true;
    huntingSession.plan = 'hunting';
    huntingSession.currentSpot = { id: 'test-spot' };
    World.user = { sessions: [leaderSession, huntingSession] };
    World.fetchNpcsInRadius = () => [{
        fetchId: () => 1002,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => undefined,
        fetchLocX: () => 80,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchName: () => 'training mob'
    }];

    HuntingState.tick(huntingSession, huntingCompanion, {}, {
        say() {},
        getRandomPhrase: () => 'target found',
        executeCombat() {}
    });

    assert.notStrictEqual(huntingSession.plan, 'shopping', 'party companion should not start random loot shopping');

    const shoppingCompanion = fakeActor(2000005, { locX: 0, locY: 0 });
    const shoppingSession = fakeSession('bot_shopping_companion', shoppingCompanion);
    shoppingSession.followPlayerSession = leaderSession;
    shoppingSession.partyCompanion = true;
    shoppingSession.plan = 'shopping';
    shoppingSession.shoppingTarget = { name: 'shop', locX: 1000, locY: 0, locZ: 0 };

    ShoppingState.tick(shoppingSession, shoppingCompanion, {}, { say() {} });

    assert.strictEqual(shoppingSession.plan, 'following', 'shopping companion should return to follow state');
    assert.strictEqual(shoppingSession.shoppingTarget, undefined, 'shopping target should be cleared for companions');
} finally {
    Math.random = originalRandom;
    World.user = originalUsers;
    World.fetchUser = originalFetchUser;
    World.fetchNpc = originalFetchNpc;
    World.fetchNpcsInRadius = originalFetchNpcsInRadius;
}

console.log('Party companion rest/follow regression checks passed');
