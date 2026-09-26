const assert = require('node:assert/strict');

require('../src/Global');

const RaidPolicy = invoke('GameServer/Clan/ClanRaidPolicy');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

const originalReadiness = Gear.combatReadiness;
let readinessCalls = 0;
Gear.combatReadiness = (entry) => {
    readinessCalls += 1;
    return entry.testReadiness || ({
    hasWeapon: true,
    armorCount: 5,
    weaponRank: 2,
    armorRank: 2,
    effectiveLevel: 54
    });
};

function member(characterId, classId, overrides = {}) {
    return {
        characterId,
        classId,
        level: 50,
        phase: 'cold',
        simulationOwner: 'legacy_main',
        ...overrides
    };
}

const members = [
    member(1, 4),
    member(2, 15),
    member(3, 17),
    member(4, 0),
    member(5, 0),
    member(6, 10),
    member(7, 9)
];
const profile = { id: 'raid:1', avgLevel: 50 };

try {
    const fresh = RaidPolicy.assessment({ members }, profile);
    assert.equal(fresh.ready, true, 'a geared seven-member role-balanced roster should be raid ready');
    assert.deepEqual(RaidPolicy.roster({ members }, profile, members[6]), [1, 2, 3, 4, 5, 6, 7]);

    const retainedMembers = members.map((entry) => ({ ...entry, partyId: 'existing-raid-party' }));
    const previousGoal = { assignedMemberIds: retainedMembers.map((entry) => entry.characterId) };
    assert.equal(RaidPolicy.assessment({ members: retainedMembers }, profile, previousGoal).ready, true,
        'the existing raid party should remain eligible during a replan');
    assert.deepEqual(RaidPolicy.roster({ members: retainedMembers }, profile, retainedMembers[6], previousGoal),
        [1, 2, 3, 4, 5, 6, 7], 'a replan should preserve the existing raid roster');

    const reclaimable = members.map((entry) => ({
        ...entry,
        partyId: 'autonomous-equipment-party',
        stats: { clanPartyObjective: { reason: 'clan_equipment', sourceKind: 'drop' } }
    }));
    assert.equal(RaidPolicy.assessment({ members: reclaimable }, profile).ready, true,
        'an autonomous ordinary equipment party should be reclaimable for a more valuable raid source');

    const conflicting = members.map((entry, index) => index === 6
        ? { ...entry, partyId: 'unrelated-party' }
        : entry);
    assert.equal(RaidPolicy.assessment({ members: conflicting }, profile).ready, false,
        'members committed to another party must not be borrowed for a raid');

    const cursed = members.map((entry, index) => index === 0 ? { ...entry, level: 59 } : entry);
    assert.equal(RaidPolicy.assessment({ members: cursed }, profile).ready, false,
        'a required role above the raid curse ceiling must not make the roster ready');

    const backedOff = members.map((entry, index) => index === 0 ? {
        ...entry,
        stats: { clanHuntBackoffs: [{ spotId: 'raid:1', until: Date.now() + 60000 }] }
    } : entry);
    assert.equal(RaidPolicy.assessment({ members: backedOff }, profile).ready, false,
        'a raid-specific safety backoff must keep a required role out of a new raid plan');

    const undergeared = members.map((entry) => ({
        ...entry,
        testReadiness: { hasWeapon: true, armorCount: 5, weaponRank: 1, armorRank: 1, effectiveLevel: 52 }
    }));
    const weak = RaidPolicy.assessment({ members: undergeared }, profile);
    assert.equal(weak.ready, false, 'a role-balanced party in the previous grade must not pull a raid boss');
    assert.equal(weak.reason, 'raid_gear_insufficient');

    const bGradeBoss = { id: 'raid:b-grade', avgLevel: 52 };
    const tankWithExpensiveWeapon = members.map((entry, index) => ({
        ...entry,
        level: 60,
        testReadiness: {
            hasWeapon: true,
            armorCount: 5,
            weaponRank: index === 0 ? 4 : 3,
            armorRank: index === 0 ? 1 : 3,
            effectiveLevel: index === 0 ? 68 : 64
        }
    }));
    assert.equal(RaidPolicy.assessment({ members: tankWithExpensiveWeapon }, bGradeBoss).ready, false,
        'a high-level tank must not qualify for a B-grade raid on weapon value while still wearing plain D armor');

    const tankWithReasonableArmor = tankWithExpensiveWeapon.map((entry, index) => index === 0 ? {
        ...entry,
        testReadiness: { ...entry.testReadiness, weaponRank: 1, armorRank: 2, effectiveLevel: 64 }
    } : entry);
    assert.equal(RaidPolicy.assessment({ members: tankWithReasonableArmor }, bGradeBoss).ready, true,
        'a complete C-grade tank kit may qualify for a B-grade boss even when the tank weapon is only D-grade');

    assert(RaidPolicy.tankArmorRequirement({ level: 48 }, { avgLevel: 45 }) < 2,
        'lower-level raid bosses must scale down naturally instead of inheriting a global C-grade floor');
    assert(RaidPolicy.tankArmorRequirement({ level: 69 }, { avgLevel: 65 }) > 2,
        'higher-level raid bosses must still demand armor above the low-level envelope');

    const mixedCurrentGrade = members.map((entry) => {
        const role = entry.characterId === 1 ? 'tank'
            : entry.characterId === 2 ? 'healer'
                : entry.characterId === 3 ? 'buffer' : 'damage';
        return {
            ...entry,
            level: 60,
            testReadiness: {
                hasWeapon: true,
                armorCount: 5,
                weaponRank: 3,
                armorRank: role === 'tank' ? 2.8 : ['healer', 'buffer'].includes(role) ? 2.4 : 2.5,
                effectiveLevel: role === 'tank' ? 66.7 : 63.3
            }
        };
    });
    const provenRaidProfile = { id: 'raid:proven', avgLevel: 59 };
    assert.equal(RaidPolicy.assessment({ members: mixedCurrentGrade }, provenRaidProfile).ready, true,
        'a strong role-balanced party with mixed B/C armor should pass the proven raid envelope');

    const successfulSephiaParty = [
        member(101, 17, { level: 63, testReadiness: { hasWeapon: true, armorCount: 5, weaponRank: 2, armorRank: 1.6, effectiveLevel: 66.54 } }),
        member(102, 48, { level: 63, testReadiness: { hasWeapon: true, armorCount: 5, weaponRank: 3, armorRank: 1.2, effectiveLevel: 68.23 } }),
        member(103, 21, { level: 61, testReadiness: { hasWeapon: true, armorCount: 5, weaponRank: 1, armorRank: 1.4, effectiveLevel: 63.16 } }),
        member(104, 33, { level: 63, testReadiness: { hasWeapon: true, armorCount: 5, weaponRank: 2, armorRank: 1.4, effectiveLevel: 67.56 } }),
        member(105, 46, { level: 59, testReadiness: { hasWeapon: true, armorCount: 5, weaponRank: 1, armorRank: 1.4, effectiveLevel: 61.86 } }),
        member(106, 5, { level: 63, testReadiness: { hasWeapon: true, armorCount: 5, weaponRank: 1, armorRank: 1.2, effectiveLevel: 66.18 } }),
        member(107, 20, { level: 63, testReadiness: { hasWeapon: true, armorCount: 5, weaponRank: 1, armorRank: 1, effectiveLevel: 66.05 } }),
        member(108, 21, { level: 63, testReadiness: { hasWeapon: true, armorCount: 5, weaponRank: 1, armorRank: 1.4, effectiveLevel: 65.16 } }),
        member(109, 30, { level: 61, testReadiness: { hasWeapon: true, armorCount: 5, weaponRank: 1, armorRank: 1.4, effectiveLevel: 63.16 } })
    ];
    assert.equal(RaidPolicy.assessment(
        { members: successfulSephiaParty },
        { id: 'raid:10137', avgLevel: 55 }
    ).ready, true, 'the observed party that defeated level 55 Sephia must remain inside the raid envelope');

    const tankHeavyClan = {
        members: [
            ...members,
            ...Array.from({ length: 7 }, (_, index) => member(200 + index, 4, { level: 55 }))
        ]
    };
    const tankHeavyRoster = RaidPolicy.roster(tankHeavyClan, profile, null);
    assert.equal(tankHeavyRoster.length, RaidPolicy.MAX_MEMBERS);
    assert.equal(RaidPolicy.composition(tankHeavyRoster.map((id) => (
        tankHeavyClan.members.find((entry) => entry.characterId === id)
    ))).ready, true, 'the final nine-member roster must retain two damage dealers in a tank-heavy clan');

    const dwarfPaddedClan = {
        members: [
            member(301, 4),
            member(302, 15),
            member(303, 17),
            member(304, 10),
            member(305, 9),
            member(306, 55),
            member(307, 57)
        ]
    };
    const dwarfPaddedAssessment = RaidPolicy.assessment(dwarfPaddedClan, profile);
    assert.equal(dwarfPaddedAssessment.ready, false,
        'a spoiler and crafter must not pad a five-member combat core into a raid-ready roster');
    assert.equal(dwarfPaddedAssessment.eligible.some((entry) => [55, 57].includes(entry.classId)), false,
        'dwarves must not manufacture the minimum combat core');

    const fillerReadiness = { hasWeapon: false, armorCount: 0, weaponRank: 0, armorRank: 0, effectiveLevel: 35 };
    const fullWithDwarves = {
        members: [
            ...members,
            member(308, 55, { testReadiness: fillerReadiness }),
            member(309, 57, { testReadiness: fillerReadiness })
        ]
    };
    const filledAssessment = RaidPolicy.assessment(fullWithDwarves, profile);
    assert.equal(filledAssessment.ready, true, 'a viable seven-member core should accept two extra bodies');
    assert.equal(filledAssessment.eligible.length, 9);
    assert.deepEqual(filledAssessment.eligible.slice(-2).map((entry) => entry.characterId), [308, 309],
        'undergeared dwarves may fill otherwise empty raid slots without counting as damage');

    const poorBuffer = members.map((entry) => entry.characterId === 3 ? {
        ...entry,
        testReadiness: fillerReadiness
    } : entry);
    assert.equal(RaidPolicy.assessment({ members: poorBuffer }, profile).ready, true,
        'caster buffer equipment must not gate raid admission');

    const twoHealingBuffers = [
        member(401, 4),
        member(402, 17),
        member(403, 51),
        member(404, 0),
        member(405, 10),
        member(406, 9),
        member(407, 7)
    ];
    assert.equal(RaidPolicy.assessment({ members: twoHealingBuffers }, profile).ready, true,
        'two healing-capable caster buffers may cover a missing dedicated healer');
    assert.equal(RaidPolicy.assessment({ members: twoHealingBuffers.filter((entry) => entry.characterId !== 403) }, profile).reason,
        'raid_roster_small');
    const oneHealingBuffer = [...twoHealingBuffers.slice(0, 2), ...twoHealingBuffers.slice(3), member(408, 0)];
    assert.equal(RaidPolicy.assessment({ members: oneHealingBuffer }, profile).reason, 'raid_healing_missing',
        'one caster buffer must not replace a dedicated healer');

    const musicRoster = [
        member(501, 4),
        member(502, 15),
        member(503, 17),
        member(504, 21),
        member(505, 34),
        member(506, 55, { testReadiness: fillerReadiness }),
        member(507, 57, { testReadiness: fillerReadiness })
    ];
    const musicComposition = RaidPolicy.composition(musicRoster);
    assert.equal(musicComposition.ready, true,
        'song and dance are optional damage members, not mandatory caster buffers');
    assert.equal(musicComposition.musicFighters, 2);
    assert.equal(musicComposition.damageRoles, 2);

    const highSinger = member(601, 21, { level: 57 });
    const secondSinger = member(602, 21, { level: 56 });
    const dancer = member(603, 34);
    const crowded = [...members, highSinger, secondSinger, dancer, member(604, 0), member(605, 9)];
    const preferred = RaidPolicy.selectRaidMembers(crowded);
    assert(preferred.includes(highSinger) && preferred.includes(dancer),
        'reserve complementary song and dance before filling with a second stronger singer');
    assert.equal(preferred.length, 9);
    const duplicateMusic = RaidPolicy.selectRaidMembers([...members, highSinger, secondSinger]);
    assert(duplicateMusic.includes(highSinger) && duplicateMusic.includes(secondSinger),
        'two singers remain valid when a dancer is unavailable');
    const warcryer = member(606, 52), overlord = member(607, 51);
    assert.equal(RaidPolicy.selectRaidMembers([...members, overlord, warcryer])[2], warcryer,
        'prefer a party-wide Orc buffer for the primary buff slot');
    assert.equal(RaidPolicy.selectRaidMembers([...members, overlord])[2], overlord,
        'a clan-wide Orc buffer is the next preference when a Warcryer is unavailable');
    assert.equal(RaidPolicy.selectRaidMembers(members)[2], members[2],
        'an Orc buffer is preferred, not required');
    const noHealer = RaidPolicy.selectRaidMembers([
        ...members.filter(m => m.characterId !== 2), warcryer, overlord, highSinger, dancer, member(608, 0)
    ]);
    assert.equal(RaidPolicy.composition(noHealer).healingBuffers, 2,
        'reserve two healing buffers without unnecessarily reserving a third');
    assert.equal(RaidPolicy.composition(noHealer).ready, true);

    readinessCalls = 0;
    const readinessCache = new Map();
    assert.equal(RaidPolicy.assessment({ members }, profile, null, { readinessCache }).ready, true);
    assert.equal(RaidPolicy.assessment({ members }, { ...profile, id: 'raid:2' }, null, { readinessCache }).ready, true);
    assert.equal(readinessCalls, members.length,
        'one planning pass must calculate each member readiness once across multiple raid bosses');

    console.log('Clan raid readiness, mixed-grade power, cache, role balance, party retention and level ceiling passed');
} finally {
    Gear.combatReadiness = originalReadiness;
}
