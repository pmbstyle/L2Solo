const Database = invoke('Database');
const ClanRules = invoke('GameServer/Clan/ClanRules');
const ClanService = invoke('GameServer/Clan/ClanService');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const Contracts = invoke('GameServer/Clan/ClanSimulationContracts');
const Policy = invoke('GameServer/Clan/ClanSimulationPolicy');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const ClanCrestService = invoke('GameServer/Clan/ClanCrestService');
const StageMetrics = invoke('GameServer/Clan/ClanStageMetrics');

const metrics = {
    founderCandidates: 0,
    founderEvaluations: 0,
    founderCreated: 0,
    founderBlocked: 0,
    existingClanJoins: 0,
    joinBlocked: 0,
    budgetStops: 0,
    budgetOverruns: 0,
    runs: 0,
    durationMs: 0,
    durationSamples: 0,
    durationMaxMs: 0,
    stages: new Map(),
    reasonCounts: new Map()
};

let founderScanOffset = 0;

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function recordReason(code) {
    if (!code) return;
    metrics.reasonCounts.set(code, (metrics.reasonCounts.get(code) || 0) + 1);
}

function recordReasons(codes = []) {
    codes.forEach(recordReason);
}

function normalizeCandidate(row = {}) {
    const stats = parseJson(row.statsJson, {});
    const generatedPersona = BotPersona.generate({
        characterId: row.characterId,
        stats: { ...stats, generatedIndex: stats.generatedIndex ?? row.characterId }
    });
    const storedPersona = row.traitsJson
        ? {
            characterId: Number(row.characterId),
            traits: parseJson(row.traitsJson, generatedPersona?.traits || {})
        }
        : generatedPersona;
    return {
        characterId: number(row.characterId),
        id: number(row.characterId),
        name: String(row.name || ''),
        username: String(row.username || ''),
        accountName: String(row.accountName || ''),
        level: number(row.level),
        classId: number(row.classId, -1),
        clanId: number(row.clanId),
        activity: String(row.activity || ''),
        phase: String(row.phase || ''),
        stats,
        partyHistory: stats.partyHistory || {},
        persona: storedPersona,
        socialRelations: parseJson(row.socialRelations, {})
    };
}

function candidateFilterSql() {
    return `c.clanId = 0
        AND (
            c.username LIKE 'bot_pop_%'
            OR c.username LIKE 'bot_scale_%'
            OR life.accountName LIKE 'bot_pop_%'
            OR life.accountName LIKE 'bot_scale_%'
            OR json_extract(CASE WHEN json_valid(COALESCE(life.statsJson, '{}')) THEN life.statsJson ELSE '{}' END, '$.generatedCold') = 1
        )
        AND c.username NOT LIKE 'bot_craft_%'
        AND COALESCE(life.accountName, '') NOT LIKE 'bot_craft_%'
        AND COALESCE(json_extract(CASE WHEN json_valid(COALESCE(life.statsJson, '{}')) THEN life.statsJson ELSE '{}' END, '$.craftStationId'), '') = ''
        AND COALESCE(json_extract(CASE WHEN json_valid(COALESCE(life.statsJson, '{}')) THEN life.statsJson ELSE '{}' END, '$.craftShop'), '') = ''`;
}

async function candidateProjection(limit = 512, offset = 0) {
    const startedAt = Date.now();
    const safeLimit = Math.max(1, Math.min(2000, Math.floor(number(limit, 512))));
    const safeOffset = Math.max(0, Math.floor(number(offset)));
    try {
        const rows = await Database.execute([`
            SELECT c.id AS characterId, c.name, c.username, c.classId, c.level, c.clanId,
                   life.accountName, life.activity, life.phase, life.statsJson,
                   persona.traitsJson
            FROM characters c
            LEFT JOIN bot_life_state life ON life.characterId = c.id
            LEFT JOIN bot_personas persona ON persona.characterId = c.id
            WHERE ${candidateFilterSql()}
            ORDER BY c.level DESC, c.id ASC
            LIMIT ${safeLimit} OFFSET ${safeOffset}
        `, []], 'clan-simulation:founder-projection');
        return rows.map(normalizeCandidate).filter((candidate) => !Policy.isStaticService(candidate));
    } finally {
        StageMetrics.record(metrics.stages, 'candidate_projection', Date.now() - startedAt);
    }
}

async function autonomousClanProjection() {
    const startedAt = Date.now();
    try {
        const rows = await Database.execute([`
            SELECT simulated.clanId, simulated.stateJson,
                   clans.name, clans.level, clans.leaderId,
                   members.id AS characterId, members.name AS memberName,
                   members.classId, members.level AS memberLevel, members.clanId AS memberClanId
            FROM clan_simulation_clans simulated
            JOIN clans ON clans.id = simulated.clanId
            LEFT JOIN characters members ON members.clanId = simulated.clanId
            WHERE simulated.mode = 'autonomous'
            ORDER BY simulated.clanId ASC, members.id ASC
        `, []], 'clan-simulation:clan-projection');
        const byId = new Map();
        rows.forEach((row) => {
            const clanId = number(row.clanId);
            if (!byId.has(clanId)) {
                byId.set(clanId, {
                    id: clanId,
                    name: String(row.name || ''),
                    level: number(row.level),
                    leaderId: number(row.leaderId),
                    state: parseJson(row.stateJson, {}),
                    members: []
                });
            }
            if (row.characterId) {
                byId.get(clanId).members.push({
                    characterId: number(row.characterId),
                    id: number(row.characterId),
                    name: String(row.memberName || ''),
                    classId: number(row.classId, -1),
                    level: number(row.memberLevel),
                    clanId: number(row.memberClanId)
                });
            }
        });
        return [...byId.values()];
    } finally {
        StageMetrics.record(metrics.stages, 'clan_projection', Date.now() - startedAt);
    }
}

function recruitmentScore(founder, candidate, members) {
    const suitability = Policy.clanSuitability(candidate, { level: 0, members }, { threshold: 0 });
    const rolePriority = suitability.roleNeed ? 1 : 0;
    return rolePriority * 2 + suitability.score + number(candidate.level) / 10000;
}

function selectRecruitment(founder, candidates, required) {
    const selected = [];
    const members = [founder];
    const pool = candidates.filter((candidate) => number(candidate.characterId) !== number(founder.characterId));
    while (selected.length < required) {
        const next = pool
            .filter((candidate) => !selected.some((entry) => entry.characterId === candidate.characterId))
            .sort((left, right) => recruitmentScore(founder, right, members) - recruitmentScore(founder, left, members)
                || number(left.characterId) - number(right.characterId))[0];
        if (!next) break;
        selected.push(next);
        members.push(next);
    }
    return selected;
}

function defaultClanName(candidate) {
    const base = String(candidate.name || `Covenant${candidate.characterId}`)
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 10) || `Covenant${candidate.characterId}`;
    return `${base}Pledge`.slice(0, 16);
}

async function joinExisting(candidate, clan, suitability) {
    const result = await Database.joinAutonomousClan({
        clanId: clan.id,
        characterId: candidate.characterId,
        memberLimit: ClanRules.memberLimit(clan.level),
        maxBotMemberShare: Config.maxBotMemberShare
    });
    if (!result.ok) {
        metrics.joinBlocked += 1;
        recordReason(result.code);
        return result;
    }
    metrics.existingClanJoins += 1;
    ClanService.reload().catch((error) => utils.infoWarn('Clan', 'failed to reload after autonomous join: %s', error.message));
    return { ...result, suitability };
}

async function resolveCandidate(candidate, options = {}) {
    const startedAt = Date.now();
    try {
        const clans = options.clans || await autonomousClanProjection();
        const existing = Policy.selectExistingClan(candidate, clans, {
            threshold: Config.existingClanSuitabilityThreshold
        });
        if (existing) {
            recordReason(Contracts.REASON_CODES.FOUNDER_EXISTING_CLAN);
            return joinExisting(candidate, existing.clan, existing.suitability);
        }

        const pool = options.pool || await candidateProjection();
        const recruits = selectRecruitment(candidate, pool, Config.founderQuorum - 1);
        const eligibility = Policy.founderEligibility(candidate, {
            quorumCandidates: [candidate, ...recruits]
        });
        metrics.founderEvaluations += 1;
        recordReasons(eligibility.reasons);
        if (!eligibility.ok) {
            metrics.founderBlocked += 1;
            return { ok: false, code: eligibility.reasons[0] || Contracts.REASON_CODES.FOUNDER_NO_QUORUM, eligibility, recruits };
        }

        const name = options.name || defaultClanName(candidate);
        const result = await Database.createAutonomousClan({
            name,
            leaderId: candidate.characterId,
            memberIds: [candidate.characterId, ...recruits.map((entry) => entry.characterId)],
            founderQuorum: Config.founderQuorum,
            maxBotClans: Config.maxBotClans,
            maxBotMemberShare: Config.maxBotMemberShare,
            stateJson: {
                leaderId: candidate.characterId,
                memberIds: [candidate.characterId, ...recruits.map((entry) => entry.characterId)],
                level: 0,
                goal: null
            }
        });
        if (!result.ok) {
            metrics.founderBlocked += 1;
            recordReason(result.code);
            return { ...result, eligibility, recruits };
        }
        metrics.founderCreated += 1;
        try {
            const crest = await ClanCrestService.ensureAutonomousCrest(result.clanId);
            if (!crest.ok) utils.infoWarn('ClanCrest', 'could not assign crest to clan %d: %s', result.clanId, crest.code);
        } catch (error) {
            utils.infoWarn('ClanCrest', 'crest assignment failed for clan %d: %s', result.clanId, error.message);
        }
        await ClanService.reload();
        return { ...result, eligibility, recruits };
    } finally {
        StageMetrics.record(metrics.stages, 'resolve_candidate', Date.now() - startedAt);
    }
}

const ClanSimulationService = {
    config: Config,
    policy: Policy,

    candidateProjection,
    autonomousClanProjection,
    founderCandidates(limit = 512) {
        return candidateProjection(limit).then((candidates) => {
            const clansPromise = autonomousClanProjection();
            return clansPromise.then((clans) => candidates.map((candidate) => {
                const existing = Policy.selectExistingClan(candidate, clans, {
                    threshold: Config.existingClanSuitabilityThreshold
                });
                const recruits = selectRecruitment(candidate, candidates, Config.founderQuorum - 1);
                const eligibility = Policy.founderEligibility(candidate, { quorumCandidates: [candidate, ...recruits] });
                return { candidate, existingClan: existing, recruits, eligibility };
            }));
        }).then((evaluations) => {
            metrics.founderCandidates = evaluations.filter((entry) => entry.eligibility.ok).length;
            return evaluations;
        });
    },

    resolveCandidate,

    async resolveBatch(limit = Config.resolveBatchSize, options = {}) {
        if (!Config.enabled) return { attempted: 0, created: 0, joined: 0, blocked: 0, budgetStopped: false };
        const startedAt = Date.now();
        const deadlineAt = startedAt + Math.max(1, number(options.budgetMs, Config.founderResolveBudgetMs));
        const safeLimit = Math.max(1, Math.min(2000, Math.floor(number(limit, Config.resolveBatchSize))));
        const scanOffset = founderScanOffset;
        const summary = { attempted: 0, created: 0, joined: 0, blocked: 0, budgetStopped: false };
        metrics.runs += 1;
        const stopForBudget = () => {
            if (!summary.budgetStopped) metrics.budgetStops += 1;
            summary.budgetStopped = true;
        };
        try {
            let candidates = await candidateProjection(safeLimit, scanOffset);
            if (Date.now() >= deadlineAt) {
                stopForBudget();
                return summary;
            }
            if (!candidates.length && scanOffset > 0) {
                founderScanOffset = 0;
                candidates = await candidateProjection(safeLimit, 0);
            }
            if (Date.now() >= deadlineAt) {
                stopForBudget();
                return summary;
            }
            if (!candidates.length) return summary;
            const clans = await autonomousClanProjection();
            if (Date.now() >= deadlineAt) {
                stopForBudget();
                return summary;
            }
            const pool = candidates;
            const scanStartedAt = Date.now();
            const reservedIds = new Set();
            let processed = 0;
            for (const candidate of candidates) {
                if (Date.now() >= deadlineAt) {
                    stopForBudget();
                    break;
                }
                processed += 1;
                if (reservedIds.has(candidate.characterId)) continue;
                const availablePool = pool.filter((entry) => !reservedIds.has(entry.characterId));
                const result = await resolveCandidate(candidate, { clans, pool: availablePool });
                summary.attempted += 1;
                if (result.ok && result.clanId && result.characterId) {
                    summary.joined += 1;
                    reservedIds.add(candidate.characterId);
                    const target = clans.find((clan) => Number(clan.id) === Number(result.clanId));
                    if (target) target.members.push({ id: candidate.characterId, characterId: candidate.characterId, classId: candidate.classId, level: candidate.level });
                } else if (result.ok && result.clanId) {
                    summary.created += 1;
                    (result.memberIds || [candidate.characterId, ...(result.recruits || []).map((entry) => entry.characterId)])
                        .forEach((id) => reservedIds.add(Number(id)));
                    clans.push({
                        id: result.clanId,
                        name: '',
                        level: 0,
                        leaderId: candidate.characterId,
                        members: (result.memberIds || []).map((id) => ({ id, characterId: id }))
                    });
                } else summary.blocked += 1;
            }
            founderScanOffset += processed;
            if (processed >= candidates.length && candidates.length < safeLimit) founderScanOffset = 0;
            StageMetrics.record(metrics.stages, 'scan_loop', Date.now() - scanStartedAt);
            return summary;
        } finally {
            const durationMs = Math.max(0, Date.now() - startedAt);
            metrics.durationMs += durationMs;
            metrics.durationSamples += 1;
            metrics.durationMaxMs = Math.max(metrics.durationMaxMs, durationMs);
            if (Date.now() > deadlineAt) metrics.budgetOverruns += 1;
            StageMetrics.record(metrics.stages, 'total', durationMs);
        }
    },

    metrics() {
        return {
            founderCandidates: metrics.founderCandidates,
            founderEvaluations: metrics.founderEvaluations,
            founderCreated: metrics.founderCreated,
            founderBlocked: metrics.founderBlocked,
            existingClanJoins: metrics.existingClanJoins,
            joinBlocked: metrics.joinBlocked,
            budgetStops: metrics.budgetStops,
            budgetOverruns: metrics.budgetOverruns,
            runs: metrics.runs,
            durationAvgMs: metrics.durationSamples ? Math.round(metrics.durationMs / metrics.durationSamples) : 0,
            durationMaxMs: metrics.durationMaxMs,
            stages: StageMetrics.snapshot(metrics.stages),
            reasonCounts: Object.fromEntries(metrics.reasonCounts.entries())
        };
    },

    resetMetrics() {
        founderScanOffset = 0;
        Object.keys(metrics).forEach((key) => {
            if (metrics[key] instanceof Map) metrics[key].clear();
            else metrics[key] = 0;
        });
    }
};

module.exports = ClanSimulationService;
