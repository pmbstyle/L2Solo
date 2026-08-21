const ClassProgression = invoke('GameServer/ClassProgression');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotServiceIdentity = invoke('GameServer/Bot/AI/BotServiceIdentity');
const ClanRules = invoke('GameServer/Clan/ClanRules');
const Contracts = invoke('GameServer/Clan/ClanSimulationContracts');

const BASE_CLASS_IDS = new Set(Object.keys(ClassProgression.firstProfMap).map(Number));
const FIRST_PROFESSION_CLASS_IDS = new Set([
    ...Object.values(ClassProgression.firstProfMap).flat(),
    ...Object.values(ClassProgression.secondProfMap).flat(),
    ...Object.values(ClassProgression.thirdClasses).map((entry) => Number(entry.parentClassId)),
    ...Object.keys(ClassProgression.thirdClasses).map(Number)
]);

const ROSTER_ROLES = Object.freeze(['tank', 'healer', 'buffer', 'dps', 'mage', 'crafter', 'spoiler']);
const DEFAULT_ROLE_WEIGHTS = Object.freeze({
    tank: 1.00,
    healer: 1.00,
    buffer: 0.95,
    dps: 0.75,
    mage: 0.80,
    crafter: 0.70,
    spoiler: 0.70
});

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, number(value)));
}

function traitsFor(candidate = {}) {
    return candidate.persona?.traits || candidate.traits || {};
}

function trait(candidate, name) {
    return clamp(traitsFor(candidate)[name]);
}

function partyHistoryRuns(candidate = {}) {
    const history = candidate.partyHistory || candidate.stats?.partyHistory || {};
    return Object.values(history).reduce((sum, entry) => sum + Math.max(0, number(entry?.runs)), 0);
}

function hasFirstProfession(candidate = {}) {
    const classId = number(candidate.classId ?? candidate.stats?.classId, -1);
    if (classId < 0 || BASE_CLASS_IDS.has(classId)) return false;
    return FIRST_PROFESSION_CLASS_IDS.has(classId);
}

function isStaticService(candidate = {}) {
    return BotServiceIdentity.isStaticService(candidate);
}

function rosterRole(candidate = {}) {
    const classId = number(candidate.classId ?? candidate.stats?.classId, -1);
    if ([56, 57].includes(classId)) return 'crafter';
    if ([54, 55].includes(classId)) return 'spoiler';
    return BotRoles.inferRole(candidate);
}

function roleCounts(members = []) {
    return members.reduce((counts, member) => {
        const role = rosterRole(member);
        counts[role] = (counts[role] || 0) + 1;
        return counts;
    }, {});
}

function rosterNeeds(members = [], desired = ROSTER_ROLES) {
    const counts = roleCounts(members);
    return desired.reduce((needs, role) => {
        if (!ROSTER_ROLES.includes(role)) return needs;
        needs[role] = Math.max(0, 1 - number(counts[role]));
        return needs;
    }, {});
}

function founderScore(candidate = {}) {
    const weighted = (
        trait(candidate, 'ambition') * 0.26
        + trait(candidate, 'assertiveness') * 0.20
        + trait(candidate, 'resilience') * 0.20
        + trait(candidate, 'sociability') * 0.18
        + trait(candidate, 'commitment') * 0.16
    );
    return clamp(weighted + (rosterRole(candidate) === 'tank' ? 0.03 : 0));
}

function founderEligibility(candidate = {}, options = {}) {
    const config = options.config || Contracts.config;
    const reasons = [];
    const level = number(candidate.level ?? candidate.stats?.level);
    const clanId = number(candidate.clanId ?? candidate.stats?.clanId);
    const quorumCandidates = Array.isArray(options.quorumCandidates)
        ? options.quorumCandidates
        : null;
    const quorumCount = number(options.quorumCount ?? candidate.quorumCount ?? quorumCandidates?.length, 0);

    if (isStaticService(candidate)) reasons.push(Contracts.REASON_CODES.JOIN_STATIC_SERVICE_CONFLICT);
    if (level < config.founderMinLevel) reasons.push(Contracts.REASON_CODES.FOUNDER_LOW_LEVEL);
    if (clanId !== 0) reasons.push(Contracts.REASON_CODES.FOUNDER_ALREADY_IN_CLAN);
    if (!hasFirstProfession(candidate)) reasons.push(Contracts.REASON_CODES.FOUNDER_NO_FIRST_PROFESSION);

    const thresholds = [
        ['ambition', config.founderAmbitionMin],
        ['assertiveness', config.founderAssertivenessMin],
        ['resilience', config.founderResilienceMin],
        ['sociability', config.founderSociabilityMin],
        ['commitment', config.founderCommitmentMin]
    ];
    if (thresholds.some(([name, minimum]) => trait(candidate, name) < number(minimum))) {
        reasons.push(Contracts.REASON_CODES.FOUNDER_TRAITS);
    }
    if (partyHistoryRuns(candidate) < number(config.founderMinPartyHistory)) {
        reasons.push(Contracts.REASON_CODES.FOUNDER_PARTY_HISTORY);
    }
    if (quorumCount < number(config.founderQuorum, 5)) {
        reasons.push(Contracts.REASON_CODES.FOUNDER_NO_QUORUM);
    }

    return {
        ok: reasons.length === 0,
        reasons,
        score: founderScore(candidate),
        role: rosterRole(candidate),
        partyHistoryRuns: partyHistoryRuns(candidate),
        quorumCount
    };
}

function socialAffinity(candidate = {}, memberIds = []) {
    if (Number.isFinite(Number(candidate.socialAffinity))) return clamp(Number(candidate.socialAffinity), 0, 100) / 100;
    const relations = candidate.socialRelations || candidate.relations || {};
    const values = memberIds.map((id) => relations[id] || relations[String(id)]).filter(Boolean);
    if (!values.length) return 0;
    return clamp(values.reduce((sum, relation) => (
        sum + number(relation.affinity) / 100 + number(relation.trust) / 100 + number(relation.familiarity) / 16
    ), 0) / (values.length * 3));
}

function clanSuitability(candidate = {}, clan = {}, options = {}) {
    if (isStaticService(candidate)) {
        return {
            ok: false,
            score: 0,
            role: rosterRole(candidate),
            reasonCodes: [Contracts.REASON_CODES.JOIN_STATIC_SERVICE_CONFLICT]
        };
    }

    const members = Array.isArray(clan.members) ? clan.members : [];
    const memberIds = members.map((member) => number(member.id ?? member.characterId)).filter(Boolean);
    const role = rosterRole(candidate);
    const needs = options.rosterNeeds || rosterNeeds(members, options.desiredRoles);
    const roleNeed = needs[role] ? 1 : 0;
    const historyScore = clamp(partyHistoryRuns(candidate) / 4);
    const affinityScore = socialAffinity(candidate, memberIds);
    const fullness = ClanRules.memberLimit(number(clan.level)) > 0
        ? 1 - members.length / ClanRules.memberLimit(number(clan.level))
        : 0;
    const commitment = trait(candidate, 'commitment');
    const weight = (options.roleWeights || DEFAULT_ROLE_WEIGHTS)[role] || 0.5;
    const score = clamp(
        roleNeed * 0.34 * weight
        + historyScore * 0.22
        + affinityScore * 0.20
        + clamp(fullness) * 0.14
        + commitment * 0.10
    );

    const reasonCodes = [];
    if (!roleNeed) reasonCodes.push(Contracts.REASON_CODES.JOIN_UNSUITABLE);
    return {
        ok: score >= number(options.threshold ?? Contracts.config.existingClanSuitabilityThreshold),
        score,
        role,
        roleNeed: !!roleNeed,
        rosterNeeds: needs,
        reasonCodes
    };
}

function selectExistingClan(candidate, clans = [], options = {}) {
    const candidates = clans
        .filter((clan) => {
            const limit = ClanRules.memberLimit(number(clan.level));
            return Array.isArray(clan.members) && clan.members.length < limit;
        })
        .map((clan) => ({ clan, suitability: clanSuitability(candidate, clan, options) }))
        .filter((entry) => entry.suitability.ok)
        .sort((left, right) => right.suitability.score - left.suitability.score
            || number(left.clan.id) - number(right.clan.id));
    return candidates[0] || null;
}

function maxBotMembers(population, share) {
    return Math.max(0, Math.floor(Math.max(0, number(population)) * clamp(share)));
}

function canReserve({ population, currentMembers, requested = 1, share }) {
    const limit = maxBotMembers(population, share);
    const next = Math.max(0, number(currentMembers)) + Math.max(0, number(requested));
    return {
        ok: next <= limit,
        limit,
        currentMembers: Math.max(0, number(currentMembers)),
        requested: Math.max(0, number(requested)),
        nextMembers: next,
        reason: next <= limit ? null : Contracts.REASON_CODES.JOIN_POPULATION_LIMIT
    };
}

module.exports = {
    BASE_CLASS_IDS,
    FIRST_PROFESSION_CLASS_IDS,
    ROSTER_ROLES,
    DEFAULT_ROLE_WEIGHTS,
    hasFirstProfession,
    isStaticService,
    rosterRole,
    roleCounts,
    rosterNeeds,
    partyHistoryRuns,
    founderScore,
    founderEligibility,
    clanSuitability,
    selectExistingClan,
    maxBotMembers,
    canReserve
};
