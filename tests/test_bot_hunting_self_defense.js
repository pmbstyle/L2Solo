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
        moves: [],
        moveTo(coords) {
            this.moves.push(coords);
        }
    };
}

function tickHunting(session, bot, db, BotAI) {
    const originalRandom = Math.random;
    Math.random = () => 0.5;
    try {
        HuntingState.tick(session, bot, db, BotAI);
    } finally {
        Math.random = originalRandom;
    }
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

tickHunting(session, bot, {}, {
    say() {},
    getStatus() { return {}; },
    executeCombat(_session, _bot, npc) {
        attackedId = npc.fetchId();
    }
});

assert.strictEqual(session.currentTargetId, threatNpc.fetchId(), 'solo hunter should target the mob that just hit it');
assert.strictEqual(bot.selected, threatNpc.fetchId(), 'solo hunter should select the incoming threat');
assert.strictEqual(attackedId, threatNpc.fetchId(), 'solo hunter should counterattack the incoming threat immediately');

const raidThreat = {
    ...threatNpc,
    fetchId: () => 1102,
    fetchName: () => 'raid boss',
    fetchIsRaidBoss: () => true,
    fetchDestId: () => bot.fetchId()
};
const raidBot = actor(2000014);
raidBot.selected = raidThreat.fetchId();
const raidSession = {
    accountId: 'bot_raid_self_defense',
    actor: raidBot,
    plan: 'hunting',
    currentTargetId: raidThreat.fetchId(),
    incomingThreatId: raidThreat.fetchId(),
    incomingThreatAt: Date.now()
};
let raidCounterattacks = 0;
World.user = { sessions: [raidSession] };
World.npc = { spawns: [raidThreat] };
World.fetchNpcsInRadius = () => [];
tickHunting(raidSession, raidBot, {}, {
    say() {},
    executeCombat() { raidCounterattacks++; }
});
assert.strictEqual(raidSession.plan, 'fleeing', 'a bot attacked by a raid entity must flee regardless of healthy resources');
assert.strictEqual(raidSession.currentTargetId, undefined, 'raid retreat must clear the protected target');
assert.strictEqual(raidCounterattacks, 0, 'self-defense must never retaliate against a raid entity');
assert.strictEqual(raidBot.moves.length, 1, 'raid retreat must immediately open distance from the boss');

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
const retreatHazard = {
    fetchId: () => 1102,
    fetchHostile: () => true,
    fetchLocX: () => -850,
    fetchLocY: () => 0,
    fetchLocZ: () => 0,
    isDead: () => false,
    state: { fetchDead: () => false }
};
let woundedAttackId = null;
World.user = { sessions: [woundedSession] };
World.npc = { spawns: [threatNpc] };
World.fetchNpcsInRadius = () => [retreatHazard];

tickHunting(woundedSession, woundedBot, {}, {
    say() {},
    executeCombat(_session, _bot, npc) {
        woundedAttackId = npc.fetchId();
    }
});

assert.strictEqual(woundedSession.plan, 'fleeing', 'critically wounded solo hunter should retreat instead of re-entering combat');
assert.strictEqual(woundedAttackId, null, 'critically wounded solo hunter should not start a futile counterattack');
assert.notStrictEqual(woundedBot.moves[0].to.locY, 0, 'solo retreat should divert around a hostile mob on the direct escape line');
assert(
    Math.hypot(
        woundedBot.moves[0].to.locX - retreatHazard.fetchLocX(),
        woundedBot.moves[0].to.locY - retreatHazard.fetchLocY()
    ) > 500,
    'solo retreat destination should remain outside the hostile mob aggro radius'
);

let seated = true;
woundedBot.state.fetchSeated = () => seated;
woundedBot.state.setSeated = (value) => { seated = value; };
woundedSession.plan = 'resting';
woundedSession.incomingThreatId = threatNpc.fetchId();
woundedSession.incomingThreatAt = Date.now();
woundedAttackId = null;
const RestingState = invoke('GameServer/Bot/AI/States/RestingState');

RestingState.tick(woundedSession, woundedBot, {}, {
    say() {},
    executeCombat(_session, _bot, npc) {
        woundedAttackId = npc.fetchId();
    }
});

assert.strictEqual(woundedSession.plan, 'fleeing', 'resting solo hunter with critical HP should retreat when attacked');
assert.strictEqual(seated, false, 'resting solo hunter should stand before retreating');
assert.strictEqual(woundedAttackId, null, 'resting solo hunter with critical HP should not counterattack immediately');

woundedBot.fetchHp = () => 50;
woundedSession.plan = 'resting';
woundedSession.recoveryLocked = true;
woundedSession.incomingThreatId = threatNpc.fetchId();
woundedSession.incomingThreatAt = Date.now();
RestingState.tick(woundedSession, woundedBot, {}, { say() {}, executeCombat() {} });
assert.strictEqual(woundedSession.plan, 'fleeing',
    'a recovery-locked bot at half HP must keep escaping instead of re-entering combat');

const exhaustedBot = actor(2000013);
exhaustedBot.fetchClassId = () => 10;
exhaustedBot.fetchMp = () => 10;
exhaustedBot.selected = threatNpc.fetchId();
const exhaustedSession = {
    accountId: 'bot_exhausted',
    actor: exhaustedBot,
    plan: 'hunting',
    currentTargetId: threatNpc.fetchId(),
    lastTargetEvaluation: { targetId: threatNpc.fetchId(), score: 500 },
    lastCombatDecision: { action: 'cast_skill', skillId: 1097 },
    lastPvpDecision: { action: 'fight' },
    dataSendToOthers() {}
};
World.user = { sessions: [exhaustedSession] };
World.npc = { spawns: [] };
World.fetchNpcsInRadius = () => [];
tickHunting(exhaustedSession, exhaustedBot, {}, { say() {}, executeCombat() {} });
assert.strictEqual(exhaustedSession.plan, 'resting', 'low-MP hunter should enter recovery');
assert.strictEqual(exhaustedSession.currentTargetId, undefined, 'voluntary recovery should release the combat target');
assert.strictEqual(exhaustedBot.selected, undefined, 'voluntary recovery should clear the visible selection');
assert.strictEqual(exhaustedSession.lastTargetEvaluation, undefined, 'recovery should clear stale target scoring');
assert.strictEqual(exhaustedSession.lastCombatDecision, undefined, 'recovery should clear stale combat choices');
assert.strictEqual(exhaustedSession.lastPvpDecision, undefined, 'recovery should clear stale PvP choices');

const lowManaDps = actor(2000015);
lowManaDps.fetchMp = () => 10;
const lowManaDpsSession = {
    accountId: 'bot_low_mana_dps',
    actor: lowManaDps,
    plan: 'hunting',
    dataSendToOthers() {}
};
const lowManaDpsChat = [];
World.user = { sessions: [lowManaDpsSession] };
World.npc = { spawns: [] };
World.fetchNpcsInRadius = () => [];
tickHunting(lowManaDpsSession, lowManaDps, {}, {
    say(_session, text) {
        lowManaDpsChat.push(text);
    },
    getStatus() { return {}; },
    executeCombat() {}
});
assert.strictEqual(lowManaDpsSession.plan, 'hunting',
    'a melee/dps hunter must not enter a recovery loop only because MP is low');
assert(!lowManaDpsChat.includes('Phew! My HP/MP is low. Sitting down to recover.'),
    'low-MP melee/dps hunters must not emit the recovery spam line');

let openingAttackSeated = false;
const openingAttackBot = actor(2000022);
openingAttackBot.fetchHp = () => 30;
openingAttackBot.state.fetchHits = () => true;
openingAttackBot.state.fetchSeated = () => openingAttackSeated;
openingAttackBot.state.setSeated = (value) => { openingAttackSeated = value; };
const openingAttackSession = {
    accountId: 'bot_opening_attack_in_flight',
    actor: openingAttackBot,
    plan: 'hunting',
    currentTargetId: threatNpc.fetchId(),
    spotRelocation: { method: 'soe_gatekeeper', startedAt: Date.now() },
    dataSendToOthers() {}
};
World.user = { sessions: [openingAttackSession] };
World.npc = { spawns: [threatNpc] };
World.fetchNpcsInRadius = () => [];
tickHunting(openingAttackSession, openingAttackBot, {}, { say() {}, executeCombat() {} });
assert.strictEqual(openingAttackSession.plan, 'hunting',
    'a hunter must not enter resting while its opening attack is still in flight');
assert.strictEqual(openingAttackSeated, false, 'an in-flight combat action must keep the hunter standing');

let betweenSwingsSeated = false;
const betweenSwingsBot = actor(2000023);
betweenSwingsBot.fetchHp = () => 30;
betweenSwingsBot.state.fetchSeated = () => betweenSwingsSeated;
betweenSwingsBot.state.setSeated = (value) => { betweenSwingsSeated = value; };
betweenSwingsBot.selected = threatNpc.fetchId();
const betweenSwingsSession = {
    accountId: 'bot_low_hp_between_swings',
    actor: betweenSwingsBot,
    plan: 'hunting',
    currentTargetId: threatNpc.fetchId(),
    dataSendToOthers() {}
};
World.user = { sessions: [betweenSwingsSession] };
World.npc = { spawns: [threatNpc] };
World.fetchNpcsInRadius = () => [];
tickHunting(betweenSwingsSession, betweenSwingsBot, {}, { say() {}, executeCombat() {} });
assert.strictEqual(betweenSwingsSession.plan, 'fleeing',
    'a critically wounded hunter must retreat from its live target between attack animations');
assert.strictEqual(betweenSwingsSeated, false,
    'a critically wounded hunter must not sit while its selected target is still alive');
assert.strictEqual(betweenSwingsSession.currentTargetId, undefined,
    'retreating between attacks should release the old combat target');

let oldAggroSeated = false;
const oldAggroBot = actor(2000016);
oldAggroBot.fetchHp = () => 30;
oldAggroBot.state.fetchSeated = () => oldAggroSeated;
oldAggroBot.state.setSeated = (value) => { oldAggroSeated = value; };
const oldAggroNpc = {
    ...threatNpc,
    fetchId: () => 1103,
    fetchDestId: () => oldAggroBot.fetchId(),
    fetchLevel: () => 5
};
const oldAggroSession = {
    accountId: 'bot_old_aggro',
    actor: oldAggroBot,
    plan: 'hunting',
    currentTargetId: oldAggroNpc.fetchId(),
    dataSendToOthers() {}
};
World.user = { sessions: [oldAggroSession] };
World.npc = { spawns: [oldAggroNpc] };
World.fetchNpcsInRadius = () => [oldAggroNpc];
tickHunting(oldAggroSession, oldAggroBot, {}, { say() {}, executeCombat() {} });
assert.strictEqual(oldAggroSession.plan, 'fleeing',
    'a critically wounded hunter must react to persistent NPC targeting even after the recent-hit window expires');
assert.strictEqual(oldAggroSeated, false, 'a hunter must never sit while an NPC still targets it');

let prematureAttacks = 0;
let reserveSeated = false;
const reserveBot = actor(2000017);
reserveBot.fetchHp = () => 60;
reserveBot.state.fetchSeated = () => reserveSeated;
reserveBot.state.setSeated = (value) => { reserveSeated = value; };
const fullHealthNpc = {
    ...threatNpc,
    fetchId: () => 1104,
    fetchLevel: () => 5,
    fetchHp: () => 100,
    fetchMaxHp: () => 100
};
const reserveSession = {
    accountId: 'bot_encounter_reserve',
    actor: reserveBot,
    plan: 'hunting',
    dataSendToOthers() {}
};
World.user = { sessions: [reserveSession] };
World.npc = { spawns: [fullHealthNpc] };
World.fetchNpcsInRadius = () => [fullHealthNpc];
tickHunting(reserveSession, reserveBot, {}, {
    say() {},
    getStatus() { return {}; },
    executeCombat() { prematureAttacks++; }
});
assert.strictEqual(reserveSession.plan, 'resting',
    'a solo hunter without enough HP reserve for a fresh equal-level mob must recover before pulling');
assert.strictEqual(reserveSeated, true, 'pre-encounter recovery should seat the safe idle hunter');
assert.strictEqual(prematureAttacks, 0, 'pre-encounter readiness must block the opening attack');
assert.strictEqual(reserveSession.lastDecision.reason, 'hp_reserve', 'the blocked pull should expose its resource reason');

let lowManaPulls = 0;
const lowManaMage = actor(2000019);
lowManaMage.fetchClassId = () => 10;
lowManaMage.fetchMp = () => 40;
const lowManaPullSession = {
    accountId: 'bot_encounter_mana_reserve',
    actor: lowManaMage,
    plan: 'hunting',
    dataSendToOthers() {}
};
World.user = { sessions: [lowManaPullSession] };
World.npc = { spawns: [fullHealthNpc] };
World.fetchNpcsInRadius = () => [fullHealthNpc];
tickHunting(lowManaPullSession, lowManaMage, {}, {
    say() {},
    getStatus() { return {}; },
    executeCombat() { lowManaPulls++; }
});
assert.strictEqual(lowManaPullSession.plan, 'resting',
    'a mana-dependent solo hunter should recover before pulling without enough MP for the encounter');
assert.strictEqual(lowManaPullSession.lastDecision.reason, 'mp_reserve');
assert.strictEqual(lowManaPulls, 0);

let companionPulls = 0;
const companionBot = actor(2000020);
companionBot.fetchHp = () => 60;
const companionSession = {
    accountId: 'bot_player_party_exclusion',
    actor: companionBot,
    plan: 'hunting',
    partyCompanion: true,
    followPlayerSession: { actor: actor(2000021) },
    dataSendToOthers() {}
};
World.user = { sessions: [companionSession] };
World.npc = { spawns: [fullHealthNpc] };
World.fetchNpcsInRadius = () => [fullHealthNpc];
tickHunting(companionSession, companionBot, {}, {
    say() {},
    getStatus() { return {}; },
    executeCombat() { companionPulls++; }
});
assert.strictEqual(companionPulls, 1,
    'the conservative solo encounter reserve must not change player-party hunting tactics');

let archerHits = true;
let archerTargetX = 120;
let archerAttacks = 0;
const kitingArcher = actor(2000018);
kitingArcher.fetchClassId = () => 9;
kitingArcher.state.fetchHits = () => archerHits;
const closeArcherThreat = {
    ...threatNpc,
    fetchId: () => 1105,
    fetchDestId: () => kitingArcher.fetchId(),
    fetchLevel: () => 5,
    fetchLocX: () => archerTargetX
};
const archerSession = {
    accountId: 'bot_archer_kite',
    actor: kitingArcher,
    plan: 'hunting',
    currentTargetId: closeArcherThreat.fetchId(),
    dataSendToOthers() {}
};
World.user = { sessions: [archerSession] };
World.npc = { spawns: [closeArcherThreat] };
World.fetchNpcsInRadius = () => [closeArcherThreat];
tickHunting(archerSession, kitingArcher, {}, {
    say() {},
    executeCombat() { archerAttacks++; }
});
assert.strictEqual(kitingArcher.moves.length, 1, 'an archer should queue movement away when its target reaches melee range');
assert.strictEqual(archerSession.lastCombatDecision.action, 'kite', 'the archer reposition should be visible as a combat decision');
assert.strictEqual(archerAttacks, 0, 'the archer should finish repositioning before firing again');

archerHits = false;
archerTargetX = 650;
tickHunting(archerSession, kitingArcher, {}, {
    say() {},
    executeCombat() { archerAttacks++; }
});
assert.strictEqual(archerAttacks, 1, 'the archer should resume attacking once distance has been restored');

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
