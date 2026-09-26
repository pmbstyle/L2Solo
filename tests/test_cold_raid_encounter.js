const assert = require('node:assert/strict');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Resolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const RaidEncounter = require('../src/GameServer/Bot/Population/ColdRaidEncounter');

DataCache.init();
RaidEncounter.resetForTests();

const originalNpcForSpot = Combat.npcForSpot;
Combat.npcForSpot = () => ({
    selfId: 10372,
    level: 20,
    maxHp: 100000,
    pAtk: 1,
    pAtkRnd: 0,
    pDef: 100,
    mDef: 100,
    accur: 1,
    evasion: 0,
    critical: 0,
    atkSpd: 253,
    rewardExp: 100,
    rewardSp: 10
});

function members(firstId, partyId) {
    return Array.from({ length: 7 }, (_, index) => ({
        characterId: firstId + index,
        name: `${partyId}-${index}`,
        level: 20,
        phase: 'cold',
        activity: 'grouped',
        loc: { locX: 0, locY: 0, locZ: 0 },
        inventory: {},
        vitals: { hp: 5000, maxHp: 5000, mp: 1000, maxMp: 1000 },
        stats: {
            classId: index === 0 ? 4 : index === 1 ? 17 : index === 2 ? 15 : 0,
            coldCombat: {
                version: 5,
                classId: index === 0 ? 4 : index === 1 ? 17 : index === 2 ? 15 : 0,
                base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
                equipment: {
                    weaponKind: 'Weapon.Sword',
                    pAtk: 500,
                    pAtkRnd: 0,
                    mAtk: 100,
                    atkSpd: 500,
                    critical: 0,
                    accur: 100,
                    pDef: 500,
                    mDef: 300,
                    evasion: 0,
                    bonusMp: index === 1 ? 10000 : 0,
                    shieldPDef: 0
                },
                skills: index === 1 ? [
                    { selfId: 1040, level: 3, passive: false, mp: 39, buffTime: 1200000 },
                    { selfId: 1068, level: 3, passive: false, mp: 35, buffTime: 1200000 }
                ] : [],
                effects: []
            }
        },
        party: { partyId, role: index === 0 ? 'tank' : index === 1 ? 'buffer' : index === 2 ? 'healer' : 'dps' }
    }));
}

function party(partyId, roster) {
    return {
        partyId,
        leaderId: roster[0].characterId,
        memberIds: roster.map((member) => member.characterId),
        spotId: 'raid:10372',
        cohesion: 0.7,
        risk: 0.2,
        stats: {
            objective: {
                sourceKind: 'raid',
                raidBossTemplateId: 10372,
                npcId: 10372,
                minPartySize: 7
            }
        }
    };
}

function mergeParty(current, result) {
    return {
        ...current,
        ...result.partyPatch,
        stats: { ...(current.stats || {}), ...(result.partyPatch?.stats || {}) }
    };
}

function mergeMembers(current, result) {
    const patches = new Map(result.memberResults.map(({ state, result: memberResult }) => (
        [state.characterId, memberResult.patch]
    )));
    return current.map((state) => {
        const patch = patches.get(state.characterId) || {};
        return {
            ...state,
            ...patch,
            vitals: { ...(state.vitals || {}), ...(patch.vitals || {}) },
            stats: { ...(state.stats || {}), ...(patch.stats || {}) }
        };
    });
}

const spot = {
    id: 'raid:10372',
    name: 'Discarded Guardian',
    center: { locX: 0, locY: 0, locZ: 0 },
    arrivalPoints: [{ locX: 650, locY: 0, locZ: 0 }],
    avgLevel: 20,
    density: 1,
    npcEntries: [{ selfId: 10372, count: 1 }],
    npcSelfIds: [10372],
    rewards: { exp: 100, sp: 10, adenaMin: 0, adenaMax: 0 },
    raidBoss: true,
    sharedEncounter: true,
    raidBossTemplateId: 10372
};

try {
    const ordinaryRaidMob = Combat.npcForSpot();
    Combat.npcForSpot = () => ({ ...ordinaryRaidMob, maxHp: 1000000000 });
    let continuityMembers = members(10, 'raid-continuous');
    let continuityParty = party('raid-continuous', continuityMembers);
    const continuityPreparation = Resolver.resolve({
        party: continuityParty,
        members: continuityMembers,
        spot,
        targetNpcId: 10372,
        elapsedMs: 60000,
        timestamp: 50000,
        rng: () => 0.5
    });
    continuityParty = mergeParty(continuityParty, continuityPreparation);
    continuityMembers = mergeMembers(continuityMembers, continuityPreparation).map((member) => ({
        ...member,
        vitals: { ...member.vitals, mp: 1 }
    }));
    const exhaustedOpener = Resolver.resolve({
        party: continuityParty,
        members: continuityMembers,
        spot,
        targetNpcId: 10372,
        elapsedMs: 60000,
        timestamp: continuityPreparation.nextResolveAt + 1,
        rng: () => 0.5
    });
    continuityParty = mergeParty(continuityParty, exhaustedOpener);
    continuityMembers = mergeMembers(continuityMembers, exhaustedOpener);
    assert.equal(continuityParty.stats.raidEncounter.status, 'active',
        'the continuity fixture must leave an active boss encounter');
    assert(continuityParty.stats.raidEncounter.encounter,
        'the continuity fixture must retain the in-progress combat state');
    assert(exhaustedOpener.memberResults.every(({ result }) => result.patch.activity !== 'resting'),
        'MP exhaustion must not pause an active raid encounter');
    assert.equal(continuityParty.stats.restUntil, null,
        'an active raid encounter must not schedule a shared recovery break');

    const staleRestUntil = exhaustedOpener.nextResolveAt + 600000;
    const staleRestingMembers = continuityMembers.map((member) => ({
        ...member,
        activity: 'resting',
        stats: { ...member.stats, restUntil: staleRestUntil }
    }));
    continuityParty = {
        ...continuityParty,
        stats: { ...continuityParty.stats, restUntil: staleRestUntil }
    };
    const resumedEncounter = Resolver.resolve({
        party: continuityParty,
        members: staleRestingMembers,
        spot,
        targetNpcId: 10372,
        elapsedMs: 15000,
        timestamp: exhaustedOpener.nextResolveAt + 1,
        rng: () => 0.5
    });
    assert(resumedEncounter.memberResults.every(({ result }) => result.patch.activity !== 'resting'),
        'a persisted rest state must not freeze an encounter that has already pulled the boss');
    assert.equal(resumedEncounter.partyPatch.stats.restUntil, null,
        'resuming an active raid encounter must clear the stale party rest deadline');

    RaidEncounter.resetForTests();
    Combat.npcForSpot = () => ({ ...ordinaryRaidMob });
    let firstMembers = members(100, 'raid-a');
    let secondMembers = members(200, 'raid-b');
    let firstParty = party('raid-a', firstMembers);
    let secondParty = party('raid-b', secondMembers);

    const noTankMembers = firstMembers.map((member, index) => index === 0 ? {
        ...member,
        party: { ...member.party, role: 'dps' },
        stats: {
            ...member.stats,
            classId: 0,
            coldCombat: { ...member.stats.coldCombat, classId: 0 }
        }
    } : member);
    const incomplete = Resolver.resolve({
        party: firstParty,
        members: noTankMembers,
        spot,
        targetNpcId: 10372,
        elapsedMs: 60000,
        timestamp: 90000,
        rng: () => 0.5
    });
    assert.equal(incomplete.debug.reason, 'raid_tank_missing');
    assert.equal(incomplete.debug.fights, 0, 'an incomplete raid roster must not pull the boss');

    const firstPreparation = Resolver.resolve({
        party: firstParty,
        members: firstMembers,
        spot,
        targetNpcId: 10372,
        elapsedMs: 60000,
        timestamp: 100000,
        rng: () => 0.5
    });
    firstParty = mergeParty(firstParty, firstPreparation);
    firstMembers = mergeMembers(firstMembers, firstPreparation);
    assert.equal(firstPreparation.debug.reason, 'raid_prepared');
    assert(firstPreparation.debug.buffCasts > 0, 'the raid party must cast its persistent package before pulling');
    assert.equal(firstParty.stats.raidEncounter.hp, null, 'preparation must not damage or aggro the boss');
    assert(firstMembers.every((member) => member.stats.coldCombat.effects.some((effect) => effect.key === 'shield')),
        'the prepared party must persist its defensive buff before combat');

    const opener = Resolver.resolve({
        party: firstParty,
        members: firstMembers,
        spot,
        targetNpcId: 10372,
        elapsedMs: 60000,
        timestamp: firstPreparation.nextResolveAt + 1,
        rng: () => 0.5
    });
    firstParty = mergeParty(firstParty, opener);
    assert.equal(opener.debug.wins, 0, 'the first clan should leave a partially damaged shared boss');
    assert(firstParty.stats.raidEncounter.hp > 0 && firstParty.stats.raidEncounter.hp < 100000);
    assert(opener.memberResults.every(({ result }) => result.materialize.items.length === 0),
        'damage without the last hit must not award raid loot');

    const secondPreparation = Resolver.resolve({
        party: secondParty,
        members: secondMembers,
        spot,
        targetNpcId: 10372,
        elapsedMs: 60000,
        timestamp: 160000,
        rng: () => 0.5
    });
    secondParty = mergeParty(secondParty, secondPreparation);
    secondMembers = mergeMembers(secondMembers, secondPreparation);
    assert.equal(secondPreparation.debug.reason, 'raid_prepared');

    const finisher = Resolver.resolve({
        party: secondParty,
        members: secondMembers,
        spot,
        targetNpcId: 10372,
        elapsedMs: 60000,
        timestamp: secondPreparation.nextResolveAt + 1,
        rng: () => 0.5
    });
    secondParty = mergeParty(secondParty, finisher);
    assert.equal(finisher.debug.wins, 1, 'a competing clan must continue from the shared remaining HP');
    assert.equal(finisher.partyPatch.status, 'dissolved', 'a successful raid party must end after settlement');
    assert.equal(finisher.partyPatch.stats.partyBreakReason, 'raid_defeated');
    assert.equal(secondParty.stats.raidEncounter.status, 'defeated');
    assert.equal(secondParty.stats.raidEncounter.winnerPartyId, 'raid-b');
    assert(finisher.memberResults.some(({ result }) => result.materialize.items.length > 0),
        'only the last-hit clan should roll the boss loot');

    const duplicate = Resolver.resolve({
        party: firstParty,
        members: firstMembers,
        spot,
        targetNpcId: 10372,
        elapsedMs: 60000,
        timestamp: 220000,
        rng: () => 0.5
    });
    assert.equal(duplicate.debug.reason, 'raid_already_defeated');
    assert.equal(duplicate.partyPatch.status, 'dissolved',
        'a persisted victorious raid must not remain active after restart');
    assert(duplicate.memberResults.every(({ result }) => result.materialize.items.length === 0),
        'a defeated shared encounter must never roll a second reward');

    RaidEncounter.resetForTests();
    const resetShared = RaidEncounter.begin(firstParty, spot, 10372, 250000);
    const resetPartial = RaidEncounter.record(firstParty, resetShared, {
        won: false,
        encounter: { hp: 25000, mob: { selfId: 10372, maxHp: 100000 } }
    }, 250001);
    const failedSnapshot = RaidEncounter.fail(firstParty, resetPartial, 250002);
    assert.equal(failedSnapshot.status, 'failed');
    assert.equal(failedSnapshot.remainingHpRatio, 0.25,
        'the failed party must retain actual boss HP for retry policy');
    const restoredForCompetitor = RaidEncounter.begin(secondParty, spot, 10372, 250003);
    assert.equal(restoredForCompetitor.status, 'active');
    assert.equal(restoredForCompetitor.hp, 100000,
        'the next attempt must see a fully restored boss');
    assert.equal(restoredForCompetitor.encounter, null,
        'combat timers from the failed attempt must not leak into the reset boss');

    RaidEncounter.resetForTests();
    Combat.npcForSpot = () => ({
        selfId: 10372,
        level: 20,
        maxHp: 100000,
        pAtk: 1000000000,
        pAtkRnd: 0,
        pDef: 100,
        mDef: 100,
        accur: 1000,
        evasion: 0,
        critical: 0,
        atkSpd: 1000,
        rewardExp: 100,
        rewardSp: 10
    });
    let doomedMembers = members(300, 'raid-doomed');
    let doomedParty = party('raid-doomed', doomedMembers);
    const doomedPreparation = Resolver.resolve({
        party: doomedParty,
        members: doomedMembers,
        spot,
        targetNpcId: 10372,
        elapsedMs: 60000,
        timestamp: 300000,
        rng: () => 0.5
    });
    doomedParty = mergeParty(doomedParty, doomedPreparation);
    doomedMembers = mergeMembers(doomedMembers, doomedPreparation);
    const wipe = Resolver.resolve({
        party: doomedParty,
        members: doomedMembers,
        spot,
        targetNpcId: 10372,
        elapsedMs: 60000,
        timestamp: doomedPreparation.nextResolveAt + 1,
        rng: () => 0.5
    });
    assert.equal(wipe.partyPatch.status, 'dissolved', 'death of a critical role must end the attempt');
    assert.equal(wipe.partyPatch.stats.partyBreakReason, 'raid_failed');
    assert.equal(wipe.partyPatch.stats.raidEncounter.status, 'failed');
    assert(wipe.partyPatch.stats.raidEncounter.remainingHpRatio > 0.3,
        'a nearly untouched boss should be marked as an unsafe retry');

    Combat.npcForSpot = () => ({ ...ordinaryRaidMob });
    const casualtyRun = (deadIndexes, hp) => {
        RaidEncounter.resetForTests();
        const roster = members(500, 'casualty');
        deadIndexes.forEach(index => { roster[index].vitals.hp = 0; roster[index].activity = 'dead'; });
        const current = party('casualty', roster);
        current.stats.raidEncounter = { version: 1, key: 'raid:10372', status: 'active', hp,
            maxHp: 100000, updatedAt: 500000,
            encounter: { version: 1, key: 'raid:10372', hp, mob: ordinaryRaidMob, at: 500000, slices: 1 } };
        return Resolver.resolve({ party: current, members: roster, spot, targetNpcId: 10372,
            elapsedMs: 15000, timestamp: 500001, rng: () => 0.5 });
    };
    const oneDead = casualtyRun([3], 90000);
    assert.equal(oneDead.debug.raidFailed, false, 'one DD casualty does not end a cold raid');
    assert.equal(oneDead.debug.deaths, 0, 'a persisted corpse is not counted as another death on each slice');
    assert(oneDead.debug.combatActions > 0, 'survivors continue fighting instead of waiting for town recovery');
    assert.equal(casualtyRun([3, 4], 90000).debug.raidFailed, true, 'multiple DD losses above half HP trigger retreat');
    assert.equal(casualtyRun([3, 4], 40000).debug.raidFailed, false, 'a weakened boss can still be finished after multiple DD losses');
    assert.equal(casualtyRun([2], 40000).debug.raidFailed, true, 'losing the healer remains terminal in cold mode');

    console.log('Cold raid encounter: shared HP, role-aware casualties, failure reset, competition and one last-hit reward passed');
} finally {
    Combat.npcForSpot = originalNpcForSpot;
    RaidEncounter.resetForTests();
}
