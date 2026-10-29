const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotRetreatPlanner = invoke('GameServer/Bot/AI/BotRetreatPlanner');
const FleeingState = invoke('GameServer/Bot/AI/States/FleeingState');

function actor(id, x, y, options = {}) {
    return {
        state: {
            fetchDead: () => false,
            fetchTowards: () => options.moving === true
        },
        fetchId: () => id,
        fetchLocX: () => x,
        fetchLocY: () => y,
        fetchLocZ: () => 0,
        fetchHp: () => options.hp ?? 100,
        fetchMaxHp: () => 100,
        fetchMp: () => options.mp ?? 100,
        fetchMaxMp: () => 100
    };
}

function hostile(id, x, y) {
    return {
        ...actor(id, x, y),
        fetchHostile: () => true,
        isDead: () => false
    };
}

const openGeodata = {
    getHeight: (_x, _y, z) => z,
    hasLineOfSight: () => true
};

const bot = actor(2000001, 0, 0);
const threat = hostile(1001, 100, 0);
const clearPlan = BotRetreatPlanner.plan(bot, threat, {
    world: { fetchNpcsInRadius: () => [threat] },
    geodata: openGeodata
});

assert.strictEqual(clearPlan.selectedAngle, 0, 'a clear retreat should keep the direct away vector');
assert.deepStrictEqual(clearPlan.to, { locX: -850, locY: 0, locZ: 0 });
assert.strictEqual(clearPlan.safe, true);

const directHazard = hostile(1002, -850, 0);
const divertedPlan = BotRetreatPlanner.plan(bot, threat, {
    world: { fetchNpcsInRadius: () => [threat, directHazard] },
    geodata: openGeodata
});

assert.notStrictEqual(divertedPlan.selectedAngle, 0, 'a hostile mob on the direct escape line should divert the bot');
assert.strictEqual(divertedPlan.safe, true, 'the selected alternate should avoid new aggro');
assert.strictEqual(divertedPlan.newAggroCount, 0);
assert.strictEqual(divertedPlan.endpointAggroCount, 0);
assert(divertedPlan.minimumEndpointClearance > 500, 'the alternate endpoint must remain outside native aggro range');
assert(
    BotRetreatPlanner.distanceToSegment(
        { locX: directHazard.fetchLocX(), locY: directHazard.fetchLocY() },
        divertedPlan.from,
        divertedPlan.to
    ) > 500,
    'the full alternate route, not only its endpoint, must avoid the hostile aggro circle'
);

const blockedDirectPlan = BotRetreatPlanner.plan(bot, threat, {
    world: { fetchNpcsInRadius: () => [threat] },
    geodata: {
        getHeight: openGeodata.getHeight,
        hasLineOfSight(_fromX, _fromY, _fromZ, _toX, toY) {
            return toY !== 0;
        }
    }
});
assert.notStrictEqual(blockedDirectPlan.selectedAngle, 0, 'a blocked direct vector should use a passable fan candidate');
assert.strictEqual(blockedDirectPlan.routeUsable, true);

const routedHazard = hostile(1005, -600, 0);
const routedPlan = BotRetreatPlanner.plan(bot, threat, {
    distance: 1500,
    world: { fetchNpcsInRadius: () => [threat, routedHazard] },
    geodata: openGeodata,
    previewRoute(from, to) {
        if (to.locY === 0 && to.locX < 0) {
            return {
                routedTo: to,
                routeUsable: true,
                strategy: 'test_astar',
                route: [
                    from,
                    { locX: 0, locY: 700, locZ: 0 },
                    { locX: -1500, locY: 700, locZ: 0 },
                    to
                ]
            };
        }
        return { routedTo: to, routeUsable: true, strategy: 'test_direct', route: [from, to] };
    }
});
assert.strictEqual(routedPlan.selectedAngle, 0, 'candidate scoring should use the safe A* preview rather than its blocked straight chord');
assert.strictEqual(routedPlan.routeStrategy, 'test_astar');
assert.strictEqual(routedPlan.safe, true, 'the actual preview polyline should own aggro safety');

const distantThreat = hostile(1006, 1000, 0);
const blockedAwayAngles = [0, -30, 30, -60, 60, -90, 90];
const crowdedHazards = blockedAwayAngles.map((angle, index) => {
    const radians = (180 + angle) * Math.PI / 180;
    return hostile(
        1200 + index,
        Math.round(Math.cos(radians) * 500),
        Math.round(Math.sin(radians) * 500)
    );
});
const crowdedPlan = BotRetreatPlanner.plan(bot, distantThreat, {
    distance: 500,
    world: { fetchNpcsInRadius: () => [distantThreat, ...crowdedHazards] },
    geodata: openGeodata
});
assert.strictEqual(crowdedPlan.movesAway, true, 'even an unsafe fallback must not shorten distance to the current attacker');
assert(
    Math.hypot(crowdedPlan.to.locX - distantThreat.fetchLocX(), crowdedPlan.to.locY - distantThreat.fetchLocY()) > 1000,
    'crowded retreat fallback should continue opening distance from the attacker'
);

const existingHazard = hostile(1003, -300, 0);
const escapingExistingAggro = BotRetreatPlanner.plan(bot, threat, {
    world: { fetchNpcsInRadius: () => [threat, existingHazard] },
    geodata: openGeodata
});
assert.strictEqual(escapingExistingAggro.selectedAngle, 0, 'a bot already inside an aggro circle should be allowed to run out of it');
assert.strictEqual(escapingExistingAggro.endpointAggroCount, 0);

const retreatSession = {};
let issuedMove = null;
const movingBot = {
    ...bot,
    moveTo(coords) { issuedMove = coords; }
};
const issuedPlan = BotRetreatPlanner.retreat(retreatSession, movingBot, threat, {
    world: { fetchNpcsInRadius: () => [threat, directHazard] },
    geodata: openGeodata
});
assert.deepStrictEqual(issuedMove, { from: issuedPlan.from, to: issuedPlan.to });
assert.strictEqual(retreatSession.lastRetreatPlan.safe, true, 'the chosen safety diagnostics should remain observable on the session');

const previewSession = { lastPathfinding: { marker: 'preserve' }, townRoutePlan: { marker: 'preserve' } };
let previewCalls = 0;
let actualRetreatCommand = null;
const previewBot = {
    ...bot,
    session: previewSession,
    moveTo(coords) {
        if (coords.previewOnly) {
            previewCalls++;
            previewSession.lastPathfinding = { marker: 'preview' };
            previewSession.townRoutePlan = { marker: 'preview' };
            return {
                requestedTo: coords.to,
                routedTo: coords.to,
                route: [coords.from, coords.to],
                routeUsable: true,
                lowLodWarp: false,
                strategy: 'test_preview'
            };
        }
        actualRetreatCommand = coords;
        return null;
    }
};
const previewedRetreat = BotRetreatPlanner.retreat(previewSession, previewBot, threat, {
    world: { fetchNpcsInRadius: () => [threat] },
    geodata: openGeodata
});
assert.strictEqual(previewCalls, 1, 'a safe direct preview should avoid unnecessary additional A star searches');
assert.strictEqual(previewedRetreat.routeStrategy, 'test_preview');
assert.deepStrictEqual(previewSession.lastPathfinding, { marker: 'preserve' }, 'candidate previews must not replace the last executed path diagnostics');
assert.deepStrictEqual(previewSession.townRoutePlan, { marker: 'preserve' }, 'candidate previews must not leak a temporary town route');
assert.deepStrictEqual(actualRetreatCommand.to, previewedRetreat.requestedTo, 'the executed command should repeat the selected preview request');

World.npc = { spawns: [] };
World.fetchNpcsInRadius = () => [];
const recoveringSession = {
    actor: actor(2000002, 0, 0, { hp: 20 }),
    plan: 'fleeing',
    fleeStart: Date.now() - 2000
};
FleeingState.tick(recoveringSession, recoveringSession.actor, {}, {});
assert.strictEqual(recoveringSession.plan, 'resting', 'a wounded bot should recover after completing its escape leg');

const lockedRecoverySession = {
    actor: actor(2000004, 0, 0, { hp: 50 }),
    plan: 'fleeing',
    recoveryLocked: true,
    fleeStart: Date.now() - 2000
};
FleeingState.tick(lockedRecoverySession, lockedRecoverySession.actor, {}, {});
assert.strictEqual(lockedRecoverySession.plan, 'resting',
    'an emergency retreat must keep recovering beyond the old 35 percent wake threshold');

const healthySession = {
    actor: actor(2000003, 0, 0),
    plan: 'fleeing',
    fleeStart: Date.now() - 2000
};
FleeingState.tick(healthySession, healthySession.actor, {}, {});
assert.strictEqual(healthySession.plan, 'hunting', 'a healthy PK escape should resume hunting after reaching safety');

const incomingAdd = {
    ...hostile(1004, -200, 0),
    fetchAttackable: () => true
};

const activePursuerNpc = {
    ...hostile(1007, 900, 0),
    fetchAttackable: () => true,
    fetchDestId: () => 2000005
};
const pursuedSession = {
    actor: actor(2000005, 0, 0, { hp: 20 }),
    plan: 'fleeing',
    fleeStart: Date.now() - 8000,
    lastRetreatPlan: { threatId: activePursuerNpc.fetchId() }
};
World.npc = { spawns: [activePursuerNpc] };
const originalRetreatForPursuer = BotRetreatPlanner.retreat;
let continuedPursuerId = null;
try {
    BotRetreatPlanner.retreat = (session, _bot, continuedThreat) => {
        continuedPursuerId = continuedThreat.fetchId();
        session.lastRetreatPlan = { threatId: continuedThreat.fetchId() };
    };
    FleeingState.tick(pursuedSession, pursuedSession.actor, {}, {});
} finally {
    BotRetreatPlanner.retreat = originalRetreatForPursuer;
}
assert.strictEqual(continuedPursuerId, activePursuerNpc.fetchId(), 'an NPC still targeting the bot inside its chase envelope should extend the escape');
assert.strictEqual(pursuedSession.plan, 'fleeing', 'the bot must not sit down in front of an active pursuer');

const staleMoveSession = {
    actor: actor(2000005, 0, 0, { hp: 20, moving: true }),
    plan: 'fleeing',
    fleeStart: Date.now() - 31000,
    lastRetreatPlan: { threatId: activePursuerNpc.fetchId() }
};
let staleMoveAborted = false;
staleMoveSession.actor.automation = {
    abortAll() { staleMoveAborted = true; }
};
World.npc = { spawns: [activePursuerNpc] };
let staleMoveReplanned = false;
try {
    BotRetreatPlanner.retreat = () => { staleMoveReplanned = true; };
    FleeingState.tick(staleMoveSession, staleMoveSession.actor, {}, {});
} finally {
    BotRetreatPlanner.retreat = originalRetreatForPursuer;
}
assert.strictEqual(staleMoveAborted, true, 'the retreat watchdog should replace a stale movement command');
assert.strictEqual(staleMoveReplanned, true, 'the retreat watchdog should replan while the NPC still owns the target');
assert.strictEqual(staleMoveSession.plan, 'fleeing', 'a stale movement flag must not end an active pursuit escape');

const escapedPursuerNpc = {
    ...activePursuerNpc,
    fetchLocX: () => 1500
};
const escapedSession = {
    actor: actor(2000005, 0, 0, { hp: 20 }),
    plan: 'fleeing',
    fleeStart: Date.now() - 8000,
    lastRetreatPlan: { threatId: escapedPursuerNpc.fetchId() }
};
World.npc = { spawns: [escapedPursuerNpc] };
FleeingState.tick(escapedSession, escapedSession.actor, {}, {});
assert.strictEqual(escapedSession.plan, 'resting', 'the bot may recover after reaching the NPC chase break distance');

const replanningSession = {
    actor: actor(2000004, 0, 0, { hp: 20 }),
    plan: 'fleeing',
    fleeStart: Date.now() - 2000,
    incomingThreatId: incomingAdd.fetchId(),
    incomingThreatAt: Date.now(),
    lastRetreatPlan: { threatId: threat.fetchId() }
};
World.npc = { spawns: [incomingAdd] };
const originalRetreat = BotRetreatPlanner.retreat;
let replannedFrom = null;
try {
    BotRetreatPlanner.retreat = (session, _bot, newThreat) => {
        replannedFrom = newThreat.fetchId();
        session.lastRetreatPlan = { threatId: newThreat.fetchId() };
    };
    FleeingState.tick(replanningSession, replanningSession.actor, {}, {});
} finally {
    BotRetreatPlanner.retreat = originalRetreat;
}
assert.strictEqual(replannedFrom, incomingAdd.fetchId(), 'a fresh add should trigger a new escape direction');
assert.strictEqual(replanningSession.plan, 'fleeing', 'replanning should keep the bot in the escape state');

// Escape is rechecked mid-run, even before the current movement leg ends.
// A fresh add cannot hide a faster pursuer that is still on the bot.
const EscapePolicy = invoke('GameServer/Bot/AI/BotEscapePolicy');
const oldScan = World.fetchNpcsInRadius;
const oldNow = Date.now;
try {
    let now = 100000;
    Date.now = () => now;
    function pursuit({ botSpeed = 124, npcSpeed = 191, raid = false } = {}) {
        let gap = 100, aborted = 0, attacks = 0, replans = 0;
        const runner = actor(2000040, 0, 0, { hp: 20, moving: true });
        runner.fetchCollectiveRunSpd = () => botSpeed;
        runner.select = data => { runner.selected = data.id; };
        runner.automation = { abortAll() { aborted++; } };
        const pursuer = { ...hostile(1040, 100, 0), fetchLocX: () => gap,
            fetchAttackable: () => true, fetchDestId: () => runner.fetchId(),
            fetchCollectiveRunSpd: () => npcSpeed, fetchIsRaidBoss: () => raid };
        const s = { actor: runner, plan: 'fleeing', recoveryLocked: true, fleeStart: now,
            lastRetreatPlan: { threatId: pursuer.fetchId() } };
        World.npc = { spawns: [pursuer] };
        World.fetchNpcsInRadius = () => [pursuer];
        BotRetreatPlanner.retreat = () => { replans++; };
        const tick = () => FleeingState.tick(s, runner, {}, { executeCombat() { attacks++; } });
        return { s, runner, pursuer, tick, setGap: value => { gap = value; },
            counts: () => ({ aborted, attacks, replans }) };
    }

    for (const speed of [191, 124]) {
        const p = pursuit({ npcSpeed: speed });
        p.tick();
        assert.strictEqual(p.s.plan, 'hunting', 'a faster or equally fast pursuer ends an ordinary escape');
        assert.deepStrictEqual(p.counts(), { aborted: 1, attacks: 1, replans: 0 });
        assert.strictEqual(p.runner.selected, p.pursuer.fetchId(), 'the bot turns to face its attacker');
        assert.strictEqual(p.s.incomingThreatId, p.pursuer.fetchId(), 'self-defense keeps the attacker across ticks');
        assert.strictEqual(p.s.recoveryLocked, true, 'recovery is still required after the fight');
        assert.strictEqual(p.s.fleeStart, undefined);
    }

    const blocked = pursuit({ botSpeed: 200, npcSpeed: 100 });
    blocked.tick();
    now += 4000;
    blocked.setGap(120);
    blocked.tick();
    assert.strictEqual(blocked.s.plan, 'fleeing', 'a routed escape gets time to open distance');
    now += 4000;
    blocked.tick();
    assert.strictEqual(blocked.s.plan, 'hunting', 'movement flags cannot keep a non-progressing escape alive');
    assert.strictEqual(blocked.s.lastDecision.reason, 'retreat_no_progress');
    assert.strictEqual(EscapePolicy.canRetreatFrom(blocked.s, blocked.runner, blocked.pursuer), false,
        'the same chase cannot immediately restart a failed escape');
    blocked.runner.fetchCollectiveRunSpd = () => 230;
    assert.strictEqual(EscapePolicy.canRetreatFrom(blocked.s, blocked.runner, blocked.pursuer), true,
        'a speed buff permits a new escape attempt');

    const gaining = pursuit({ botSpeed: 200, npcSpeed: 100 });
    gaining.tick();
    for (let step = 1; step <= 4; step++) {
        now += 8000;
        gaining.setGap(100 + step * 150);
        gaining.tick();
        assert.strictEqual(gaining.s.plan, 'fleeing', 'a useful escape survives the progress checks and watchdog');
    }
    gaining.setGap(1500);
    now += 2000;
    World.fetchNpcsInRadius = () => [];
    gaining.runner.state.fetchTowards = () => false;
    gaining.tick();
    assert.strictEqual(gaining.s.plan, 'resting', 'a successful escape finishes in recovery');
    assert.strictEqual(gaining.s.retreatProgress, undefined);

    const slowPrimary = pursuit({ botSpeed: 200, npcSpeed: 100 });
    const fastPursuer = { ...slowPrimary.pursuer, fetchId: () => 1041, fetchCollectiveRunSpd: () => 250 };
    World.fetchNpcsInRadius = () => [slowPrimary.pursuer, fastPursuer];
    slowPrimary.tick();
    assert.strictEqual(slowPrimary.runner.selected, fastPursuer.fetchId(), 'the faster add prevents an impossible escape');

    const lostBuff = pursuit({ botSpeed: 200, npcSpeed: 150 });
    lostBuff.tick();
    assert.strictEqual(lostBuff.s.plan, 'fleeing');
    lostBuff.runner.fetchCollectiveRunSpd = () => 124;
    lostBuff.tick();
    assert.strictEqual(lostBuff.s.plan, 'hunting', 'losing a speed buff interrupts a now-impossible escape mid-leg');

    const alternating = pursuit({ botSpeed: 200, npcSpeed: 100 });
    const secondPursuer = { ...alternating.pursuer, fetchId: () => 1042 };
    World.npc.spawns.push(secondPursuer);
    World.fetchNpcsInRadius = () => [alternating.pursuer, secondPursuer];
    alternating.tick();
    for (let step = 1; step <= 4; step++) {
        now += 2000;
        alternating.s.lastRetreatPlan = { threatId: step % 2 ? secondPursuer.fetchId() : alternating.pursuer.fetchId() };
        alternating.tick();
    }
    assert.strictEqual(alternating.s.plan, 'hunting', 'alternating pursuers cannot reset the no-progress deadline');

    const raid = pursuit({ raid: true });
    raid.tick();
    now += 31000;
    raid.tick();
    assert.strictEqual(raid.s.plan, 'fleeing', 'a faster raid boss must not provoke an unauthorized attack');
    assert.strictEqual(raid.counts().attacks, 0);
} finally {
    World.fetchNpcsInRadius = oldScan;
    BotRetreatPlanner.retreat = originalRetreat;
    Date.now = oldNow;
}

// Party defense must remain attached to the leader even when the geometrical
// away vector points out of camp. Solo escape behavior above stays unchanged.
const partyLeader = actor(3000000, 0, 0);
const partyOptions = {
    partyAnchor: partyLeader, preferredPoint: partyLeader, partyRadius:450, distance:500,
    world:{fetchNpcsInRadius:()=>[]}, geodata:openGeodata
};
for (const [x,y,enemyX,enemyY] of [[400,0,300,0],[1200,0,1100,0],[0,0,100,0],[0,-400,0,-300]]) {
    const companion = actor(3000001,x,y);
    const attacker = hostile(3000002,enemyX,enemyY);
    const escape = BotRetreatPlanner.plan(companion,attacker,partyOptions);
    assert.strictEqual(escape.partyMovementAllowed,true);
    assert(Math.hypot(escape.to.locX,escape.to.locY)<=451,'party escape endpoint must stay around the leader');
    if(Math.hypot(x,y)>450) assert(Math.hypot(escape.to.locX,escape.to.locY)<Math.hypot(x,y),'separated companion must move back toward the party');
}
let circling = actor(3000003,400,0);
for(let step=0;step<12;step++) {
    const pursuer=hostile(3000004,circling.fetchLocX()-40,circling.fetchLocY());
    const escape=BotRetreatPlanner.plan(circling,pursuer,partyOptions);
    assert(Math.hypot(escape.to.locX,escape.to.locY)<=451,'repeated damage must not walk the companion away from camp');
    circling=actor(3000003,escape.to.locX,escape.to.locY);
}
const detouredPartyPlan = BotRetreatPlanner.plan(actor(3000005,300,0),hostile(3000006,250,0),{
    ...partyOptions,
    previewRoute(_from,to){return {routedTo:to,routeUsable:true,route:[{locX:1500,locY:0,locZ:0},to]};}
});
assert.strictEqual(detouredPartyPlan.partyMovementAllowed,false,'nearby destination must not hide a path that leaves the party');
const blockedCompanion=actor(3000007,200,0);
let blockedMoves=0;
blockedCompanion.moveTo=()=>{blockedMoves++;};
const blockedPartyPlan=BotRetreatPlanner.retreat({},blockedCompanion,hostile(3000008,150,0),{
    ...partyOptions,geodata:{...openGeodata,hasLineOfSight:()=>false}
});
assert.strictEqual(blockedPartyPlan.partyMovementAllowed,false);
assert.strictEqual(blockedMoves,0,'blocked party routes must not fall back to an unbounded escape command');
const movingLeaderPlan=BotRetreatPlanner.plan(actor(3000009,400,0),hostile(3000010,350,0),{
    ...partyOptions,partyAnchor:actor(3000011,1100,0)
});
assert(Math.hypot(movingLeaderPlan.to.locX-1100,movingLeaderPlan.to.locY)<=451,'next route must use the current leader position');

console.log('Bot safe-retreat planner checks passed');
