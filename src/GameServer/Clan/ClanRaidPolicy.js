const ClanPolicy = invoke('GameServer/Clan/ClanSimulationPolicy');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Roles = invoke('GameServer/Bot/AI/BotRoles');

const MIN_MEMBERS = 7;
const MAX_MEMBERS = 9;
const MAX_LEVEL_ABOVE_BOSS = 8;
const MAX_LEVEL_BELOW_BOSS = 5;
const GRADE_RANK = Object.freeze({ none: 0, d: 1, c: 2, b: 3, a: 4, s: 5 });
const MIN_EFFECTIVE_LEVEL_ADVANTAGE = 2;
const EFFECTIVE_LEVEL_GEAR_COMPENSATION = 4;
const ARMOR_GRADE_TOLERANCE = Object.freeze({
    // A raid tank may reasonably wear the complete heavy kit from the grade
    // immediately below the boss' natural grade.  Extra levels can cover
    // only a fraction of one more grade; they must never erase armor from the
    // admission decision entirely.
    tank: 1,
    healer: 0.75,
    buffer: 0.75,
    default: 0.5
});
const DAMAGE_ROLES = new Set(['dps', 'mage', 'dagger', 'archer']);

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function memberId(member) {
    return number(member?.characterId ?? member?.id);
}

function readinessFor(member, cache = null) {
    if (!cache) return Gear.combatReadiness(member);
    const key = memberId(member) || member;
    if (!cache.has(key)) cache.set(key, Gear.combatReadiness(member));
    return cache.get(key);
}

function availableMember(member, profile, retained = new Set(), timestamp = Date.now()) {
    const id = memberId(member);
    const level = number(member?.level);
    const bossLevel = number(profile?.avgLevel);
    if (!id || member?.phase !== 'cold') return false;
    if (member?.partyId && !retained.has(id)) {
        const objective = member?.stats?.clanPartyObjective;
        const reclaimableEquipmentParty = objective?.reason === 'clan_equipment'
            && objective?.sourceKind !== 'raid'
            && objective?.raidBoss !== true
            && objective?.controlledBy !== 'player';
        // Clan equipment planning already has an atomic party-reform step.
        // Let it consider its own ordinary farming roster; otherwise those
        // groups permanently hide the exact tank/healer/buffer needed to
        // discover a worthwhile raid source. Never borrow foreign, player
        // controlled, or already active raid groups here.
        if (!reclaimableEquipmentParty) return false;
    }
    if (String(member?.simulationOwner || 'legacy_main') !== 'legacy_main') return false;
    if (bossLevel && (level < bossLevel - MAX_LEVEL_BELOW_BOSS || level > bossLevel + MAX_LEVEL_ABOVE_BOSS)) return false;
    if ((member?.stats?.clanHuntBackoffs || []).some((entry) => (
        String(entry?.spotId || '') === String(profile?.id || '')
        && number(entry?.until) > number(timestamp)
    ))) return false;
    return true;
}

function raidRole(member) {
    if (Roles.isPartyMusicFighter(member)) return 'damage';
    const role = ClanPolicy.rosterRole(member);
    if (DAMAGE_ROLES.has(role)) return 'damage';
    if (role === 'spoiler' || role === 'crafter') return 'filler';
    return role;
}

function requiredGearRank(profile = {}) {
    return GRADE_RANK[Gear.gradeForLevel(number(profile.avgLevel, 1))] || 0;
}

function tankArmorRequirement(member, profile = {}) {
    const requiredRank = requiredGearRank(profile);
    const levelAdvantage = Math.max(0, number(member?.level) - number(profile?.avgLevel));
    const veteranArmorCredit = Math.min(0.75, Math.max(0,
        (levelAdvantage - MIN_EFFECTIVE_LEVEL_ADVANTAGE) / 8
    ));
    return Math.max(0, requiredRank - ARMOR_GRADE_TOLERANCE.tank - veteranArmorCredit);
}

function effectiveCombatLevel(member, readiness, role = ClanPolicy.rosterRole(member)) {
    if (role === 'buffer' && !Roles.isPartyMusicFighter(member)) return number(member?.level);
    const effective = number(readiness?.effectiveLevel, member?.level);
    if (role !== 'tank') return effective;
    // Rebuild the tank score from the stable survival inputs.  Subtracting a
    // weapon contribution from the opaque effectiveLevel would make this
    // depend on how old snapshots happened to calculate that aggregate.
    const armorKit = Math.min(0.45, number(readiness?.armorCount) * 0.1);
    return Math.max(1,
        number(member?.level, effective)
        + number(readiness?.armorRank) * 0.65
        + armorKit
        + 0.45
    );
}

function combatCapable(member, profile, readinessCache = null) {
    const role = ClanPolicy.rosterRole(member);
    // A caster buffer earns its raid slot through buffs and emergency heals.
    // Its armor is not an admission gate: if the boss turns on it, the pull is
    // already in serious trouble regardless of one extra equipment grade.
    if (role === 'buffer' && !Roles.isPartyMusicFighter(member)) return true;
    const readiness = readinessFor(member, readinessCache);
    const requiredRank = requiredGearRank(profile);
    const support = ['healer', 'buffer'].includes(role);
    const armorTolerance = ARMOR_GRADE_TOLERANCE[role] ?? ARMOR_GRADE_TOLERANCE.default;
    const armorReady = number(readiness.armorRank) >= (role === 'tank'
        ? tankArmorRequirement(member, profile)
        : Math.max(0, requiredRank - armorTolerance));
    const gradeReady = armorReady && (role === 'tank'
        || number(readiness.weaponRank) >= Math.max(0, requiredRank - (support ? 1 : 0)));
    // The first observed bot raid kill was made by a veteran party whose raw
    // item grades were below the boss grade, but whose effective levels were
    // safely above it. Preserve that proven route while the +8 curse ceiling
    // in `availableMember` still prevents trivial over-level farming.
    const veteranCompensation = number(readiness.effectiveLevel, member?.level)
        >= number(profile?.avgLevel) + EFFECTIVE_LEVEL_GEAR_COMPENSATION;
    return readiness.hasWeapon
        && readiness.armorCount >= (role === 'tank' ? 3 : 2)
        && (role === 'tank' ? gradeReady : (gradeReady || veteranCompensation));
}

function feasibility(members = [], profile = {}, readinessCache = null) {
    const bossLevel = number(profile.avgLevel);
    const readiness = members.map((member) => ({
        member,
        role: ClanPolicy.rosterRole(member),
        readiness: readinessFor(member, readinessCache)
    }));
    const averageEffectiveLevel = readiness.length
        ? readiness.reduce((sum, entry) => sum + effectiveCombatLevel(
            entry.member,
            entry.readiness,
            entry.role
        ), 0) / readiness.length
        : 0;
    const tankEffectiveLevel = Math.max(0, ...readiness
        .filter((entry) => entry.role === 'tank')
        .map((entry) => effectiveCombatLevel(entry.member, entry.readiness, entry.role)));
    const ready = members.length >= MIN_MEMBERS
        && averageEffectiveLevel >= bossLevel + MIN_EFFECTIVE_LEVEL_ADVANTAGE
        && tankEffectiveLevel >= bossLevel + MIN_EFFECTIVE_LEVEL_ADVANTAGE;
    return {
        ready,
        averageEffectiveLevel,
        tankEffectiveLevel,
        requiredGearRank: requiredGearRank(profile),
        reason: members.length < MIN_MEMBERS ? 'raid_gear_insufficient'
            : averageEffectiveLevel < bossLevel + MIN_EFFECTIVE_LEVEL_ADVANTAGE ? 'raid_party_power_low'
                : tankEffectiveLevel < bossLevel + MIN_EFFECTIVE_LEVEL_ADVANTAGE ? 'raid_tank_power_low'
                    : 'raid_power_ready'
    };
}

function composition(members = []) {
    const roles = ClanPolicy.roleCounts(members);
    const classified = members.map(raidRole);
    const tanks = classified.filter((role) => role === 'tank').length;
    const healers = classified.filter((role) => role === 'healer').length;
    const buffers = members.filter((member) => raidRole(member) === 'buffer').length;
    const healingBuffers = members.filter((member) => (
        raidRole(member) === 'buffer' && Roles.isHealingBuffer(member)
    )).length;
    const musicFighters = members.filter(Roles.isPartyMusicFighter).length;
    const damageRoles = classified.filter((role) => role === 'damage').length;
    const healingReady = healers >= 1 || healingBuffers >= 2;
    const ready = members.length >= MIN_MEMBERS
        && tanks >= 1
        && buffers >= 1
        && healingReady
        && damageRoles >= 2;
    return {
        ready,
        roles,
        tanks,
        healers,
        buffers,
        healingBuffers,
        musicFighters,
        damageRoles,
        reason: members.length < MIN_MEMBERS ? 'raid_roster_small'
            : !tanks ? 'raid_tank_missing'
                : !buffers ? 'raid_buffer_missing'
                    : !healingReady ? 'raid_healing_missing'
                        : damageRoles < 2 ? 'raid_damage_missing' : 'raid_ready'
    };
}

function selectRaidMembers(members = [], readinessCache = null, beneficiary = null) {
    const ranked = [...members].sort((left, right) => (
        number(readinessFor(right, readinessCache).effectiveLevel, right.level)
        - number(readinessFor(left, readinessCache).effectiveLevel, left.level)
        || number(right.level) - number(left.level)
        || memberId(left) - memberId(right)
    ));
    const selected = [];
    const selectedIds = new Set();
    const add = (member) => {
        const id = memberId(member);
        if (!member || !id || selectedIds.has(id) || selected.length >= MAX_MEMBERS) return false;
        selected.push(member);
        selectedIds.add(id);
        return true;
    };
    add(ranked.find((member) => raidRole(member) === 'tank'));
    // Warcryer buffs the party; Overlord covers its clan. Both reduce the
    // long single-target preparation, but neither is a mandatory raid slot.
    const bufferPriority = member => Roles.roleClassId(member) === 52 ? 0
        : Roles.roleClassId(member) === 51 ? 1 : 2;
    const buffers = ranked.filter(member => raidRole(member) === 'buffer')
        .sort((a, b) => bufferPriority(a) - bufferPriority(b));
    const healer = ranked.find((member) => raidRole(member) === 'healer');
    if (healer) add(healer);
    else buffers.filter((member) => Roles.isHealingBuffer(member))
        .slice(0, 2).forEach(add);
    add(buffers[0]);
    // Songs and dances are useful, but occupy ordinary damage slots rather
    // than the mandatory buffer/healer structure.
    const music = ranked.filter(member => Roles.isPartyMusicFighter(member));
    add(music[0]);
    add(music.find(member => Roles.roleClassId(member) !== Roles.roleClassId(music[0])));
    ranked.filter((member) => raidRole(member) === 'damage')
        .slice(0, 2)
        .forEach(add);
    const beneficiaryId = memberId(beneficiary);
    if (beneficiaryId && ranked.length > MAX_MEMBERS) {
        add(ranked.find((member) => memberId(member) === beneficiaryId));
    }
    // Once support is covered, spare slots contribute damage before adding
    // another caster buffer. An extra support can still fill an empty slot.
    ranked.filter(member => raidRole(member) === 'damage').forEach(add);
    ranked.forEach(add);
    return selected;
}

function assessment(clan = {}, profile = {}, previousGoal = null, options = {}) {
    const readinessCache = options.readinessCache || new Map();
    const retained = new Set((previousGoal?.assignedMemberIds || []).map(number).filter(Boolean));
    const timestamp = Date.now();
    const available = (clan.members || []).filter((member) => (
        availableMember(member, profile, retained, timestamp)
    ));
    const candidates = available.filter((member) => (
        raidRole(member) !== 'filler' && combatCapable(member, profile, readinessCache)
    ));
    const core = selectRaidMembers(candidates, readinessCache, options.beneficiary);
    const coreComposition = composition(core);
    if (!coreComposition.ready) {
        const possibleComposition = composition(available.filter((member) => raidRole(member) !== 'filler'));
        const reason = possibleComposition.ready ? 'raid_gear_insufficient' : coreComposition.reason;
        return { ...coreComposition, ready: false, reason, eligible: core, candidates, available,
            minMembers: MIN_MEMBERS, maxMembers: MAX_MEMBERS };
    }
    const eligible = [...core];
    const selectedIds = new Set(eligible.map(memberId));
    // Once a viable seven- or eight-member core exists, empty slots are more
    // valuable than perfect equipment. Dwarves and other undergeared members
    // may fill them, but can never manufacture the core by themselves.
    if (eligible.length < MAX_MEMBERS) {
        [...available]
            .filter((member) => !selectedIds.has(memberId(member)))
            .sort((left, right) => number(right.level) - number(left.level) || memberId(left) - memberId(right))
            .forEach((member) => {
                if (eligible.length >= MAX_MEMBERS) return;
                eligible.push(member);
                selectedIds.add(memberId(member));
            });
    }
    const raidComposition = composition(eligible);
    const power = feasibility(core, profile, readinessCache);
    const raidEstimate = require('./ClanRaidEstimate').estimate(eligible, profile, readinessCache);
    const ready = raidComposition.ready && power.ready;
    return {
        ...raidComposition,
        ...power,
        ready,
        reason: !raidComposition.ready ? 'raid_gear_insufficient' : power.reason,
        eligible,
        core,
        raidEstimate,
        candidates,
        minMembers: MIN_MEMBERS,
        maxMembers: MAX_MEMBERS
    };
}

function roster(clan, profile, beneficiary, previousGoal = null) {
    const ready = assessment(clan, profile, previousGoal, { beneficiary });
    if (!ready.ready) return [];
    return ready.eligible.map(memberId).filter(Boolean);
}

module.exports = {
    MIN_MEMBERS,
    MAX_MEMBERS,
    MAX_LEVEL_ABOVE_BOSS,
    MAX_LEVEL_BELOW_BOSS,
    MIN_EFFECTIVE_LEVEL_ADVANTAGE,
    EFFECTIVE_LEVEL_GEAR_COMPENSATION,
    ARMOR_GRADE_TOLERANCE,
    availableMember,
    raidRole,
    requiredGearRank,
    tankArmorRequirement,
    effectiveCombatLevel,
    combatCapable,
    feasibility,
    composition,
    selectRaidMembers,
    assessment,
    roster
};
