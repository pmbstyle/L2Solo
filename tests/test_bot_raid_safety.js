const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const BotAI = invoke('GameServer/Bot/BotAI');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const PartyClassTactics = invoke('GameServer/Bot/AI/PartyClassTactics');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const BotHuntingTargetPolicy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
const FleeingState = invoke('GameServer/Bot/AI/States/FleeingState');
const EffectStore = invoke('GameServer/Effects/EffectStore');

function actor(id, options = {}) {
    return {
        selfId: options.selfId,
        minionBossObjectId: options.minionBossObjectId,
        fetchId: () => id,
        fetchSelfId: () => options.selfId,
        fetchName: () => options.name || `actor_${id}`,
        fetchLocX: () => options.locX || 0,
        fetchLocY: () => options.locY || 0,
        fetchLocZ: () => options.locZ || 0,
        fetchLevel: () => options.level || 20,
        fetchClassId: () => options.classId ?? 0,
        fetchHp: () => options.hp ?? 100,
        fetchMaxHp: () => options.maxHp ?? 100,
        fetchMp: () => options.mp ?? 100,
        fetchMaxMp: () => options.maxMp ?? 100,
        fetchPDef: () => options.pDef ?? 50,
        fetchClanName: () => options.clanName || '',
        fetchAttackable: () => options.attackable === true,
        fetchIsRaidBoss: () => options.raidBoss === true,
        fetchDestId: () => options.targetId,
        fetchIsOnline: () => true,
        isDead: () => false,
        state: {
            fetchDead: () => false,
            fetchTowards: () => false,
            fetchHits: () => options.hits === true,
            fetchCasts: () => options.casts === true,
            fetchCombats: () => options.combats === true
        },
        backpack: {
            fetchEquippedArmors: () => options.heavyArmor
                ? [{ fetchKind: () => 'Armor.Chain' }]
                : []
        }
    };
}

const leader = actor(5001);
const leaderSession = { actor: leader };
const companion = actor(5002);
const companionSession = {
    actor: companion,
    partyCompanion: true,
    followPlayerSession: leaderSession
};
const boss = actor(6001, {
    selfId: 10001,
    name: 'raid boss',
    attackable: true,
    raidBoss: true,
    targetId: companion.fetchId(),
    locX: 100
});
const minion = actor(6002, {
    selfId: 10002,
    name: 'raid minion',
    attackable: true,
    minionBossObjectId: boss.fetchId(),
    locX: 120
});
const staleBoss = actor(6004, {
    selfId: 10004,
    name: 'stale raid boss',
    attackable: true,
    raidBoss: true,
    locX: 160
});
const regular = actor(6003, {
    selfId: 1,
    name: 'ordinary monster',
    attackable: true,
    locX: 140
});
const siegeGuard = actor(6005, {
    selfId: 12114,
    name: 'Dion Bow Guard s E',
    clanName: 'Door, Dion Siege',
    attackable: true,
    locX: 180
});

assert.strictEqual(BotRaidSafety.isProtectedRaidEntity(boss), true, 'a live raid boss must be protected');
assert.strictEqual(BotRaidSafety.isProtectedRaidEntity(minion), true, 'a live linked raid minion must be protected');
assert.strictEqual(BotRaidSafety.isProtectedRaidEntity({ selfId: 10002 }), true,
    'a cold raid minion template must be protected without a live boss object');
assert.strictEqual(BotRaidSafety.isProtectedRaidEntity({ template: { kind: 'Boss' } }), true,
    'legacy grandboss templates must be protected even without a raidBoss flag');
assert.strictEqual(BotRaidSafety.isProtectedRaidEntity(regular), false, 'ordinary monsters must remain eligible');
assert.strictEqual(BotHuntingTargetPolicy.isSiegeGuard(siegeGuard), true,
    'runtime castle defenders must retain their sourced siege identity');
assert.strictEqual(BotHuntingTargetPolicy.isSiegeGuard({ clan: { clanName: 'Door, Oren Siege' } }), true,
    'cold castle-defender records must retain their sourced siege identity');
assert.strictEqual(BotHuntingTargetPolicy.canHunt({ template: { name: 'Oren Royal Gatekeeper' } }), false,
    'misclassified castle teleporters must not keep castle sectors in the hunting atlas');
assert.strictEqual(BotHuntingTargetPolicy.canHunt({ template: { kind: 'Boss', name: 'Antharas' } }), false,
    'boss templates without a raidBoss flag must still be absent from bot hunting logic');
assert.strictEqual(BotHuntingTargetPolicy.canHunt({ clan: { clanName: 'ant_clan' } }), true,
    'ordinary monster clans must remain eligible even when the NPC name contains Guard');

World.user = { sessions: [leaderSession, companionSession] };
World.npc = { spawns: [boss, minion, regular, siegeGuard], grid: {} };
World.fetchNpcsInRadius = () => [boss, minion, regular, siegeGuard];

const threat = PartyAwareness.findThreatTargetingParty(leaderSession);
assert.strictEqual(threat.type, 'raid', 'a raid entity targeting the party must be reported as an escape threat');
assert.strictEqual(threat.actor, boss, 'raid safety must outrank ordinary party combat decisions');

const originalFetchNpcsInRadius = World.fetchNpcsInRadius;
const originalBossTarget = boss.fetchDestId;
let projectedSpatialScans = 0;
World.fetchNpcsInRadius = (...args) => {
    projectedSpatialScans += 1;
    return originalFetchNpcsInRadius(...args);
};
PartyAwareness.invalidateThreatProjection(leaderSession);
assert.strictEqual(PartyAwareness.findThreatTargetingPartyProjected(leaderSession)?.actor, boss,
    'the shared party projection must preserve normal threat selection');
const scansAfterProjectionMiss = projectedSpatialScans;
assert(scansAfterProjectionMiss > 0, 'the first party projection must perform a real spatial scan');
assert.strictEqual(PartyAwareness.findThreatTargetingPartyProjected(leaderSession)?.actor, boss,
    'a repeated hot decision must reuse the same short-lived party projection');
assert.strictEqual(projectedSpatialScans, scansAfterProjectionMiss,
    'the cached party projection must not repeat per-member spatial scans');
boss.fetchDestId = () => undefined;
PartyAwareness.invalidateThreatProjection(leaderSession);
assert.strictEqual(PartyAwareness.findThreatTargetingPartyProjected(leaderSession), null,
    'explicit invalidation must expose a changed threat immediately');
boss.fetchDestId = originalBossTarget;
PartyAwareness.invalidateThreatProjection(leaderSession);
World.fetchNpcsInRadius = originalFetchNpcsInRadius;

leader.fetchDestId = () => boss.fetchId();
assert.strictEqual(PartyAwareness.leaderCombatTargetId(leaderSession), null,
    'companions must not inherit a player-selected raid target');

SpotService.reset();
const spots = SpotService.ensureIndexed();
const indexedIds = spots.flatMap((spot) => spot.npcSelfIds || []);
assert(indexedIds.includes(regular.fetchSelfId()), 'ordinary monsters must remain in hunting-ground profiles');
assert(!indexedIds.includes(boss.fetchSelfId()), 'raid bosses must not create bot hunting grounds');
assert(!indexedIds.includes(minion.fetchSelfId()), 'raid minions must not create bot hunting grounds');
assert(!indexedIds.includes(siegeGuard.fetchSelfId()), 'castle guards must not create bot hunting grounds');

const tank = actor(5100, { classId: 5, hp: 500, maxHp: 1000, pDef: 500, heavyArmor: true });
const heavyFighter = actor(5101, { classId: 1, hp: 1000, maxHp: 1000, pDef: 600, heavyArmor: true });
const mage = actor(5102, { classId: 10, hp: 700, maxHp: 700, mp: 900, maxMp: 1000, pDef: 200 });
const tankSession = { actor: tank, partyCompanion: true, followPlayerSession: leaderSession };
const heavySession = { actor: heavyFighter, partyCompanion: true, followPlayerSession: leaderSession };
const mageSession = { actor: mage, partyCompanion: true, followPlayerSession: leaderSession };
boss.model = { raidBoss: true, raidAttackers: new Set() };
boss.fetchDestId = () => undefined;
World.user.sessions = [leaderSession, tankSession, heavySession, mageSession];
delete leaderSession.partyRaidEngagement;

let engagement = BotRaidSafety.syncPlayerPartyRaid(leaderSession, 1000);
assert.strictEqual(engagement.phase, 'opening', 'selecting a raid boss must create a player-led opening phase');
assert.strictEqual(engagement.openerId, tank.fetchId(), 'a real tank must remain the opener before a healthier heavy-armored damage dealer');
assert.strictEqual(BotRaidSafety.isRaidOpenerReady(tank), false, 'a critically low tank must wait for recovery before opening');
assert.strictEqual(BotRaidSafety.canEngagePlayerPartyRaid(tankSession, boss, leaderSession), true,
    'the designated tank must be allowed through the opening combat guard');
assert.strictEqual(BotRaidSafety.canEngagePlayerPartyRaid(heavySession, boss, leaderSession), false,
    'other companions must wait until the opener establishes combat');
assert.strictEqual(BotRaidSafety.canEngagePlayerPartyRaid(tankSession, minion, leaderSession), false,
    'the opener must attack the selected boss rather than pull through a minion');

const originalLeaderCombatState = leader.state.fetchCombats;
const originalMinionTarget = minion.fetchDestId;
delete leaderSession.partyRaidEngagement;
leader.fetchDestId = () => minion.fetchId();
leader.state.fetchCombats = () => true;
boss.fetchDestId = () => undefined;
minion.fetchDestId = () => leader.fetchId();
engagement = BotRaidSafety.syncPlayerPartyRaid(leaderSession, 1000);
assert.strictEqual(engagement.bossId, boss.fetchId(),
    'a player-selected minion must resolve to its live raid boss');
assert.strictEqual(engagement.targetId, minion.fetchId(),
    'the player-selected raid minion must remain the party combat target');
assert.strictEqual(engagement.phase, 'combat',
    'a player actively attacking a raid minion must release the party into combat immediately');
assert.strictEqual(BotRaidSafety.leaderDesignatedRaidTarget(leaderSession)?.target, minion,
    'raid target resolution must preserve the selected minion object');
assert.strictEqual(BotRaidSafety.canEngagePlayerPartyRaid(mageSession, minion, leaderSession), true,
    'all companions may assist a player-led raid after the player attacks a minion');
assert.strictEqual(PartyAwareness.findThreatTargetingParty(leaderSession)?.actor, minion,
    'the selected minion must flow through normal party threat assistance');
assert.strictEqual(PartyAwareness.leaderCombatTargetId(leaderSession, { allowPlayerRaid: true }), minion.fetchId(),
    'the explicit player-party assist path must expose an engaged selected minion');

leader.state.fetchCombats = originalLeaderCombatState;
leader.fetchDestId = () => boss.fetchId();
minion.fetchDestId = originalMinionTarget;
delete leaderSession.partyRaidEngagement;

boss.model.raidAttackers.add(leader.fetchId());
engagement = BotRaidSafety.syncPlayerPartyRaid(leaderSession, 1000);
assert.strictEqual(engagement.phase, 'opening',
    'a historical raid hit must not turn a later target selection into active combat');

leader.state.fetchCombats = () => true;
engagement = BotRaidSafety.syncPlayerPartyRaid(leaderSession, 1001);
assert.strictEqual(engagement.phase, 'combat', 'a player hit must release the party into standard raid combat');
staleBoss.model = { raidBoss: true, raidAttackers: new Set() };
World.npc.spawns = [boss, minion, regular, staleBoss];
leaderSession.partyRaidEngagement = {
    bossId: staleBoss.fetchId(),
    bossTemplateId: staleBoss.fetchSelfId(),
    openerId: tank.fetchId(),
    phase: 'combat',
    selectedAt: 900,
    lastActiveAt: 1001
};
engagement = BotRaidSafety.syncPlayerPartyRaid(leaderSession, 1002);
assert.strictEqual(engagement.bossId, boss.fetchId(),
    'live player combat with the selected boss must replace a stale engagement entity atomically');
assert.strictEqual(engagement.phase, 'combat',
    'the reconciled selected boss must remain normal party combat without an opening retreat race');
boss.fetchDestId = () => leader.fetchId();
assert.strictEqual(BotRaidSafety.canEngagePlayerPartyRaid(heavySession, boss, leaderSession), true,
    'all companions may attack the boss after combat begins');
assert.strictEqual(BotRaidSafety.canEngagePlayerPartyRaid(mageSession, minion, leaderSession), true,
    'raid minions become valid party combat and control targets after the pull');
const raidAttacks = [];
assert.strictEqual(BotAI.executeCombat(heavySession, heavyFighter, boss, {
    attackExec(_session, _actor, data) { raidAttacks.push(data); },
    skillExec() {}
}, { playerPartyRaidLeaderSession: leaderSession }), true,
'the final combat guard must admit an explicitly engaged player-party raid');
assert.strictEqual(raidAttacks[0]?.id, boss.fetchId(), 'authorized party combat must reach the selected raid boss');
assert.strictEqual(PartyAwareness.findThreatTargetingParty(leaderSession).type, 'npc',
    'an engaged raid boss must flow through standard party combat rather than raid escape');
assert.strictEqual(PartyAwareness.leaderCombatTargetId(leaderSession), null,
    'the default target API must continue hiding raids from pull and solo consumers');
assert.strictEqual(PartyAwareness.leaderCombatTargetId(leaderSession, { allowPlayerRaid: true }), boss.fetchId(),
    'the explicit player-party assist path may expose the engaged boss');

boss.fetchDestId = () => undefined;
minion.fetchDestId = () => tank.fetchId();
assert.strictEqual(PartyAwareness.findThreatTargetingParty(leaderSession).type, 'npc',
    'a matching engaged raid minion must remain a normal party assist target');
tankSession.incomingThreatId = minion.fetchId();
tankSession.incomingThreatAt = Date.now();
EffectStore.apply(minion, { key: 'sleep', id: 1069, category: 'sleep', type: 'debuff', duration: 30000 });
assert.strictEqual(PartyAwareness.findThreatTargetingParty(leaderSession), null,
    'a controlled raid minion must not be restored from recent incoming threat and woken by allies');
EffectStore.remove(minion, 'sleep');
delete tankSession.incomingThreatId;
delete tankSession.incomingThreatAt;

const sleepSkill = {
    fetchSelfId: () => 1069,
    fetchConsumedMp: () => 20
};
mage.skillset = { fetchSkill: (id) => Number(id) === 1069 ? sleepSkill : null };
const control = PartyClassTactics.supportCrowdControl(mage, [boss, minion], { primaryTargetId: boss.fetchId() });
assert.strictEqual(control?.target, minion, 'a mage must use learned single-target sleep on a raid minion add');
assert.strictEqual(control?.skill, sleepSkill, 'raid add control must use the mage actual learned skill');
assert.strictEqual(BotRaidSafety.hasControlledRaidMinion(boss), false,
    'ordinary raid combat must keep the standard area-damage policy before an add is controlled');
EffectStore.apply(minion, { key: 'root', id: 1208, type: 'debuff', durationMs: 10000, rooted: true });
assert.strictEqual(BotRaidSafety.hasControlledRaidMinion(boss), false,
    'root alone must not be treated as hard control because the minion can still attack and cast');
assert.strictEqual(PartyAwareness.findThreatTargetingParty(leaderSession)?.actor, minion,
    'a rooted raid minion that can still attack must remain a combat threat');
assert.strictEqual(PartyClassTactics.supportCrowdControl(mage, [boss, minion], { primaryTargetId: boss.fetchId() })?.target, minion,
    'hard control may still be applied to a merely rooted add');
EffectStore.remove(minion, 'root');
EffectStore.apply(minion, { key: 'sleep', id: 1069, category: 'sleep', type: 'debuff', duration: 30000 });
assert.strictEqual(BotRaidSafety.hasControlledRaidMinion(boss), true,
    'area damage must be suppressed while a linked raid minion is under hard control');
EffectStore.remove(minion, 'sleep');

delete leaderSession.partyRaidEngagement;
boss.model.raidAttackers.clear();
leader.state.fetchCombats = () => false;
boss.fetchDestId = () => undefined;
World.user.sessions = [leaderSession, heavySession, mageSession];
engagement = BotRaidSafety.syncPlayerPartyRaid(leaderSession, 1100);
assert.strictEqual(engagement.openerId, heavyFighter.fetchId(), 'heavy armor must be the fallback opener when no tank is present');
delete leaderSession.partyRaidEngagement;
World.user.sessions = [leaderSession, mageSession];
engagement = BotRaidSafety.syncPlayerPartyRaid(leaderSession, 1200);
assert.strictEqual(engagement.openerId, mage.fetchId(), 'any remaining companion must be able to open when no tank or heavy armor exists');

const safeCompanion = actor(5003, { locX: 2500 });
const holdingCompanion = {
    actor: safeCompanion,
    partyCompanion: true,
    followPlayerSession: leaderSession,
    plan: 'fleeing',
    raidSafetyResumePlan: 'following',
    fleeStart: Date.now() - 2000
};
delete leaderSession.partyRaidEngagement;
leader.fetchDestId = () => undefined;
boss.fetchDestId = () => leader.fetchId();
World.user.sessions = [leaderSession, holdingCompanion];
PartyAwareness.invalidateThreatProjection(leaderSession);
FleeingState.tick(holdingCompanion, safeCompanion, {}, {});
assert.strictEqual(holdingCompanion.plan, 'fleeing',
    'a companion already at safe range must stay away while its leader is still fighting a raid entity');

const fleeingCompanion = {
    ...companionSession,
    plan: 'fleeing',
    raidSafetyResumePlan: 'following',
    fleeStart: Date.now() - 2000
};
boss.fetchDestId = () => undefined;
World.user.sessions = [leaderSession, fleeingCompanion];
PartyAwareness.invalidateThreatProjection(leaderSession);
FleeingState.tick(fleeingCompanion, companion, {}, {});
assert.strictEqual(fleeingCompanion.plan, 'following', 'a companion must return to its party after escaping a raid entity');
assert.strictEqual(fleeingCompanion.followPlayerSession, leaderSession, 'raid retreat must preserve the companion relationship');

console.log('Bot raid safety checks passed');
