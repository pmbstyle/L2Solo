const assert = require('assert');

require('../src/Global');

const BotAI = invoke('GameServer/Bot/BotAI');
const revive = invoke('GameServer/Actor/Generics/Revive');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const BotManager = invoke('GameServer/Bot/BotManager');

function botAt(loc) {
    return {
        fetchLocX: () => loc.locX,
        fetchLocY: () => loc.locY,
        fetchLocZ: () => loc.locZ,
        fetchKarma: () => loc.karma || 0,
        fetchClassId: () => loc.classId || 0,
        fetchPrivateStore: () => false
    };
}

const huntingSpot = { locX: 45000, locY: 45000, locZ: -3000 };
const huntingSession = {
    plan: 'hunting',
    initialSpawnCoord: huntingSpot,
    currentSpot: { id: 'hunting_spot' }
};

assert.deepStrictEqual(
    BotAI.getDeathRespawnTarget(huntingSession, botAt(huntingSpot), false),
    { locX: 46976, locY: 51511, locZ: -2976 },
    'solo hunting death should restart at the nearest town instead of the active hunting spot'
);

const elvenRuinsSpot = { locX: 49315, locY: 248452, locZ: -5960 };
assert.deepStrictEqual(
    BotAI.getDeathRespawnTarget({ plan: 'hunting', initialSpawnCoord: elvenRuinsSpot }, botAt(elvenRuinsSpot), false),
    { locX: -84058, locY: 244604, locZ: -3728 },
    'a bot death inside Elven Ruins should restart on Talking Island instead of Giran'
);

const pkRestart = BotAI.getDeathRespawnTarget({ plan: 'pk_hunting' }, botAt({ locX: 76000, locY: 144000, locZ: -3400, karma: 720 }), false);
assert.ok(
    invoke('GameServer/World/TownRespawn').CHAOTIC_RESPAWNS.giran_town.some(([x, y, z]) => x === pkRestart.locX && y === pkRestart.locY && z === pkRestart.locZ),
    'a PK bot death must use the sourced Giran chaotic restart set rather than a town gatekeeper'
);

const merchantSession = {
    plan: 'merchant',
    initialSpawnCoord: { locX: 83396, locY: 147904, locZ: -3404 }
};

assert.deepStrictEqual(
    BotAI.getDeathRespawnTarget(merchantSession, botAt({ locX: 90000, locY: 148000, locZ: -3400 }), false),
    merchantSession.initialSpawnCoord,
    'merchant death should preserve the fixed store respawn location'
);

const deadSession = {
    currentTargetId: 1001,
    targetTrackId: 1001,
    targetAcquiredAt: Date.now(),
    targetLastDistance: 80,
    targetStallTicks: 3,
    incomingThreatId: 1002,
    incomingThreatAt: Date.now(),
    roleDecision: { action: 'defend_self' },
    lastDecision: { action: 'abandon_target' },
    lastTargetEvaluation: { targetId: 1001, score: 500 },
    lastCombatDecision: { action: 'basic_attack' },
    lastPvpDecision: { action: 'fight' }
};
BotAI.clearTacticalState(deadSession);
assert.strictEqual(deadSession.currentTargetId, undefined, 'death should release the active target immediately');
assert.strictEqual(deadSession.incomingThreatId, undefined, 'death should clear incoming threat state');
assert.strictEqual(deadSession.roleDecision, undefined, 'death should clear stale role decisions');
assert.strictEqual(deadSession.lastDecision, undefined, 'death should clear stale hunting decisions');
assert.strictEqual(deadSession.lastTargetEvaluation, undefined, 'death should clear stale target scoring');
assert.strictEqual(deadSession.lastCombatDecision, undefined, 'death should clear stale combat choices');
assert.strictEqual(deadSession.lastPvpDecision, undefined, 'death should clear stale PvP choices');

const respawningBot = {
    hp: 0,
    mp: 0,
    fetchId: () => 200001,
    fillupVitals() {
        this.hp = 100;
        this.mp = 100;
    },
    automation: {
        stopReplenish() {},
        replenishVitals() { throw new Error('bot town respawn must not wait for gradual regeneration'); }
    },
    state: {
        dead: true,
        setDead(value) { this.dead = value; }
    }
};
const respawnPackets = [];
revive({
    dataSendToMeAndOthers(packet) { respawnPackets.push(packet); }
}, respawningBot, { delayMs: 0, restoreFullVitals: true });
assert.strictEqual(respawningBot.state.dead, false, 'bot must be alive before its immediate town teleport');
assert.strictEqual(respawningBot.hp, 100, 'bot town respawn should restore HP before teleport validation');
assert.strictEqual(respawnPackets.length, 2, 'bot town respawn should send revive and stand-up packets synchronously');

const recoveryLeader = {
    actor: {
        fetchId: () => 201,
        fetchIsOnline: () => true,
        fetchLocX: () => 10000,
        fetchLocY: () => 10000,
        fetchLocZ: () => -3000
    }
};
const recoveringCompanion = {
    actor: botAt(huntingSpot),
    partyCompanion: true,
    followPlayerSession: recoveryLeader,
    plan: 'following',
    botStay: true,
    stayLocation: { locX: 44000, locY: 44000, locZ: -3000 }
};
const recoveryTarget = BotAI.beginPartyTownRecovery(recoveringCompanion, recoveringCompanion.actor, 5_000);
assert.deepStrictEqual(recoveryTarget, { locX: 46976, locY: 51511, locZ: -2976 }, 'timed-out companion should first restart in the nearest town');
assert.strictEqual(recoveringCompanion.partyCompanion, true, 'town recovery must preserve native party membership');
assert.strictEqual(recoveringCompanion.followPlayerSession, recoveryLeader, 'town recovery must preserve the party leader');
assert.strictEqual(recoveringCompanion.plan, 'getting_buffed', 'town recovery should enter the conditional rebuff flow');
assert.strictEqual(recoveringCompanion.resumeAfterBuff.returnMode, 'teleport', 'town recovery should use const-party teleport semantics when returning');
assert.strictEqual(recoveringCompanion.resumeAfterBuff.readyAt, 6_500, 'return should wait for the town teleport to settle');
assert.strictEqual(recoveringCompanion.botStay, false, 'death recovery should return to the live party instead of the old corpse hold point');

const partyPackets = [];
const partyLeader = {
    actor: {
        fetchId: () => 201,
        fetchName: () => 'Party leader',
        fetchCp: () => 0,
        fetchMaxCp: () => 0,
        fetchHp: () => 100,
        fetchMaxHp: () => 100,
        fetchMp: () => 100,
        fetchMaxMp: () => 100,
        fetchLevel: () => 20,
        fetchClassId: () => 0
    },
    dataSendToMe(packet) { partyPackets.push(packet); }
};
const dismissedCompanion = {
    actor: {
        fetchId: () => 202,
        fetchName: () => 'Timed out companion',
        attack: { abortCast() {}, clearTimers() {} },
        automation: { abortAll() {} },
        state: { setHits() {}, setCasts() {} },
        unselect() {}
    },
    partyCompanion: true,
    followPlayerSession: partyLeader,
    plan: 'following'
};
const originalSessions = BotManager.sessions;
BotManager.sessions = [dismissedCompanion];
try {
    assert.strictEqual(
        PartyCompanionService.clearCompanion(dismissedCompanion, { plan: 'hunting', refreshPanel: false }),
        true,
        'an explicit companion dismissal should detach it from its leader'
    );
} finally {
    BotManager.sessions = originalSessions;
}
assert.strictEqual(dismissedCompanion.partyCompanion, false, 'dismissed companion should clear party membership');
assert.strictEqual(dismissedCompanion.followPlayerSession, null, 'dismissed companion should clear its leader reference');
assert.strictEqual(partyPackets.some((packet) => packet[0] === 0x50), true, 'explicit dismissal must clear the player party window immediately');

console.log('Bot death respawn checks passed');
