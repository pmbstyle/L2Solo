const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const HuntingState = invoke('GameServer/Bot/AI/States/HuntingState');

function state() {
    return {
        fetchTowards: () => false,
        fetchHits: () => false,
        fetchCasts: () => false,
        fetchDead: () => false,
        fetchSeated: () => false,
        setSeated() {}
    };
}

function actor(id) {
    return {
        state: state(),
        fetchId: () => id,
        fetchName: () => `actor_${id}`,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchHp: () => 100,
        fetchMaxHp: () => 100,
        fetchMp: () => 100,
        fetchMaxMp: () => 100,
        fetchLevel: () => 5,
        fetchClassId: () => 0,
        fetchKarma: () => 0,
        fetchIsOnline: () => true,
        activeBuffs: {
            windWalk: Date.now() + 600000,
            shield: Date.now() + 600000,
            haste: Date.now() + 600000
        },
        backpack: {
            fetchEquippedWeapon: () => null,
            fetchItemFromSelfId: () => ({ fetchAmount: () => 100 })
        },
        select(data) {
            this.selected = data.id;
        },
        unselect() {
            this.selected = undefined;
        },
        moveTo() {}
    };
}

const threatNpc = {
    fetchId: () => 1101,
    fetchName: () => 'angry mob',
    fetchAttackable: () => true,
    isDead: () => false,
    fetchLocX: () => 120,
    fetchLocY: () => 0,
    fetchLocZ: () => 0
};

const bot = actor(2000010);
const session = {
    accountId: 'bot_self_defense',
    actor: bot,
    plan: 'hunting',
    incomingThreatId: threatNpc.fetchId(),
    incomingThreatAt: Date.now()
};
let attackedId = null;

World.user = { sessions: [session] };
World.npc = { spawns: [threatNpc] };
World.fetchNpcsInRadius = () => [];

HuntingState.tick(session, bot, {}, {
    say() {},
    getStatus() { return {}; },
    executeCombat(_session, _bot, npc) {
        attackedId = npc.fetchId();
    }
});

assert.strictEqual(session.currentTargetId, threatNpc.fetchId(), 'solo hunter should target the mob that just hit it');
assert.strictEqual(bot.selected, threatNpc.fetchId(), 'solo hunter should select the incoming threat');
assert.strictEqual(attackedId, threatNpc.fetchId(), 'solo hunter should counterattack the incoming threat immediately');

const woundedBot = actor(2000011);
woundedBot.fetchHp = () => 20;
const woundedSession = {
    accountId: 'bot_wounded_self_defense',
    actor: woundedBot,
    plan: 'hunting',
    incomingThreatId: threatNpc.fetchId(),
    incomingThreatAt: Date.now(),
    dataSendToOthers() {}
};
let woundedAttackId = null;
World.user = { sessions: [woundedSession] };

HuntingState.tick(woundedSession, woundedBot, {}, {
    say() {},
    executeCombat(_session, _bot, npc) {
        woundedAttackId = npc.fetchId();
    }
});

assert.strictEqual(woundedSession.plan, 'hunting', 'wounded solo hunter should not sit while under attack');
assert.strictEqual(woundedAttackId, threatNpc.fetchId(), 'wounded solo hunter should defend itself before resting');

let seated = true;
woundedBot.state.fetchSeated = () => seated;
woundedBot.state.setSeated = (value) => { seated = value; };
woundedSession.plan = 'resting';
woundedAttackId = null;
const RestingState = invoke('GameServer/Bot/AI/States/RestingState');

RestingState.tick(woundedSession, woundedBot, {}, {
    say() {},
    executeCombat(_session, _bot, npc) {
        woundedAttackId = npc.fetchId();
    }
});

assert.strictEqual(woundedSession.plan, 'hunting', 'resting solo hunter should wake when attacked');
assert.strictEqual(seated, false, 'resting solo hunter should stand before defending itself');
assert.strictEqual(woundedAttackId, threatNpc.fetchId(), 'resting solo hunter should counterattack immediately');

async function targetLifecycleChecks() {
    const originalRandom = Math.random;
    Math.random = () => 0.5;

    try {
        const unreachableNpc = {
            fetchId: () => 1201,
            fetchName: () => 'unreachable mob',
            fetchAttackable: () => true,
            isDead: () => false,
            fetchLocX: () => 900,
            fetchLocY: () => 0,
            fetchLocZ: () => 0,
            fetchLevel: () => 5
        };
        const stalledBot = actor(2000012);
        stalledBot.state.fetchTowards = () => true;
        const stalledSession = {
            accountId: 'bot_stalled_target',
            actor: stalledBot,
            plan: 'hunting',
            currentTargetId: unreachableNpc.fetchId()
        };
        World.user = { sessions: [stalledSession] };
        World.npc = { spawns: [unreachableNpc] };
        World.fetchNpcsInRadius = () => [unreachableNpc];
        World.fetchUser = () => Promise.reject(new Error('user_not_found'));
        World.fetchNpc = () => Promise.resolve(unreachableNpc);

        for (let i = 0; i < 6; i++) {
            HuntingState.tick(stalledSession, stalledBot, {}, {
                say() {},
                getStatus() { return {}; },
                executeCombat() {}
            });
            await new Promise((resolve) => setImmediate(resolve));
        }

        assert.strictEqual(stalledSession.currentTargetId, undefined, 'hunter should abandon a target after repeated movement without progress');
        assert(stalledSession.targetRetryAfter?.[unreachableNpc.fetchId()] > Date.now(), 'abandoned target should receive a retry cooldown');
        assert.strictEqual(stalledSession.lastDecision.reason, 'no_progress', 'target abandonment should be observable');

        HuntingState.tick(stalledSession, stalledBot, {}, {
            say() {},
            getStatus() { return {}; },
            executeCombat() {}
        });
        assert.strictEqual(stalledSession.currentTargetId, undefined, 'hunter should not immediately reacquire a cooled-down target');

        let rejectOldLookup;
        let fetchedNpcId = null;
        stalledSession.currentTargetId = unreachableNpc.fetchId();
        World.fetchUser = () => new Promise((_resolve, reject) => { rejectOldLookup = reject; });
        World.fetchNpc = (id) => {
            fetchedNpcId = id;
            return Promise.resolve(unreachableNpc);
        };

        HuntingState.tick(stalledSession, stalledBot, {}, {
            say() {},
            getStatus() { return {}; },
            executeCombat() {}
        });
        stalledSession.currentTargetId = 9999;
        rejectOldLookup(new Error('user_not_found'));
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(fetchedNpcId, unreachableNpc.fetchId(), 'NPC fallback should use the captured target id');
        assert.strictEqual(stalledSession.currentTargetId, 9999, 'stale target callbacks should not clear a newer target');
    } finally {
        Math.random = originalRandom;
    }
}

targetLifecycleChecks()
    .then(() => console.log('Bot hunting self-defense checks passed'))
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    });
