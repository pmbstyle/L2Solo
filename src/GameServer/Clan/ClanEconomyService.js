const { DiagnosticMetricMap } = require('../Bot/Population/DiagnosticMetricMap');
const DiagnosticConfig = require('../Bot/Population/PopulationConfig');
const Database = invoke('Database');
const ClanService = invoke('GameServer/Clan/ClanService');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const Contracts = invoke('GameServer/Clan/ClanSimulationContracts');
const Policy = invoke('GameServer/Clan/ClanContributionPolicy');
const ClanWarehouseService = invoke('GameServer/Clan/ClanWarehouseService');
const BotServiceIdentity = invoke('GameServer/Bot/AI/BotServiceIdentity');
const ClanCrestService = invoke('GameServer/Clan/ClanCrestService');

const metrics = {
    resolves: 0,
    contributionsBlocked: 0,
    levelUps: 0,
    budgetStops: 0,
    reasonCounts: new DiagnosticMetricMap()
};

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
    if (code) DiagnosticConfig.developerDiagnostics && metrics.reasonCounts.set(code, (metrics.reasonCounts.get(code) || 0) + 1);
}

async function clanProjection() {
    const rows = await Database.execute([`
        SELECT simulated.clanId, simulated.stateJson,
               clans.name, clans.level, clans.leaderId,
               members.id AS characterId, members.name AS memberName,
               members.classId, members.level AS memberLevel, members.clanId AS memberClanId,
               life.accountName, life.activity, life.phase, life.adena, life.simulationRevision,
               life.inventorySummary, life.statsJson
        FROM clan_simulation_clans simulated
        JOIN clans ON clans.id = simulated.clanId
        JOIN characters members ON members.clanId = simulated.clanId
        LEFT JOIN bot_life_state life ON life.characterId = members.id
        ORDER BY simulated.clanId ASC, members.id ASC
    `, []], 'clan-simulation:economy-projection');
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
        const stats = parseJson(row.statsJson, {});
        const member = {
            characterId: number(row.characterId),
            id: number(row.characterId),
            name: String(row.memberName || ''),
            classId: number(row.classId, -1),
            level: number(row.memberLevel),
            clanId: number(row.memberClanId),
            accountName: String(row.accountName || ''),
            activity: String(row.activity || ''),
            phase: String(row.phase || ''),
            adena: number(row.adena),
            simulationRevision: number(row.simulationRevision),
            inventory: parseJson(row.inventorySummary, {}),
            stats
        };
        if (!BotServiceIdentity.isStaticService(member)) byId.get(clanId).members.push(member);
    });
    return [...byId.values()];
}

// Levels 0-1: the members' hourly dues (ClanHall/Runtime -> settleClanDues) fill the
// contribution ledger; this action advances the level once the ledger holds the
// requirement and, at level 1, deposits the members' surplus into the warehouse.
async function resolveClan(clan, options = {}) {
    if (!clan || number(clan.level) < 0 || number(clan.level) > 3) {
        return { ok: true, skipped: true, reason: 'level_out_of_slice' };
    }
    if (number(clan.level) === 3) {
        const result = await Database.resolveBotClanAlliance(clan.id);
        if (result.advanced?.ok) { DiagnosticConfig.developerDiagnostics && (metrics.levelUps += 1); await ClanService.reload(); }
        return result;
    }
    const targetLevel = number(clan.level);
    if (targetLevel >= 2) return { ok: true, skipped: true, reason: 'level_two_contributions_deferred' };
    const requiredAmount = Policy.scaledAdenaRequirement(targetLevel);
    const summary = (await Database.fetchClanContributionSummary(clan.id, targetLevel))[0] || { amount: 0 };
    const contributedAmount = number(summary.amount);
    let advanced = { ok: false, code: Contracts.REASON_CODES.CONTRIBUTION_LEVEL_READY };
    if (contributedAmount >= requiredAmount) {
        advanced = await Database.advanceAutonomousClanLevel({
            clanId: clan.id,
            fromLevel: targetLevel,
            toLevel: targetLevel + 1,
            requiredAmount
        });
        if (advanced.ok) {
            DiagnosticConfig.developerDiagnostics && (metrics.levelUps += 1);
            await ClanCrestService.ensureAutonomousCrest(clan.id);
            recordReason(Contracts.REASON_CODES.CONTRIBUTION_LEVEL_UP);
        } else {
            DiagnosticConfig.developerDiagnostics && (metrics.contributionsBlocked += 1);
            recordReason(advanced.code);
        }
    }
    let warehouse = null;
    if (targetLevel === 1) {
        // Spending the level's Adena moved the warehouse revision.
        if (advanced.ok) clan.state = { ...(clan.state || {}), warehouseRevision: number(advanced.warehouseRevision) };
        warehouse = await ClanWarehouseService.resolveClan(clan, {
            batchSize: Config.warehouseDepositBatchSize,
            deadlineAt: Number.isFinite(Number(options.deadlineAt)) ? Number(options.deadlineAt) : Infinity
        });
    }
    return {
        ok: true,
        clanId: clan.id,
        level: targetLevel,
        requiredAmount,
        contributedAmount,
        shortfall: Math.max(0, requiredAmount - contributedAmount),
        advanced,
        warehouse
    };
}

const ClanEconomyService = {
    config: Config,
    policy: Policy,
    clanProjection,
    resolveClan,

    resolveBatch(limit = Config.resolveBatchSize, options = {}) {
        if (!Config.enabled) return Promise.resolve({ attempted: 0, levelUps: 0, contributions: 0, blocked: 0 });
        const deadlineAt = Date.now() + Math.max(1, number(options.budgetMs, Config.resolveBudgetMs));
        return clanProjection().then(async (clans) => {
            const summary = { attempted: 0, levelUps: 0, contributions: 0, blocked: 0, budgetStopped: false };
            for (const clan of clans.slice(0, Math.max(1, number(limit, Config.resolveBatchSize)))) {
                if (Date.now() >= deadlineAt) {
                    DiagnosticConfig.developerDiagnostics && (metrics.budgetStops += 1);
                    summary.budgetStopped = true;
                    break;
                }
                const result = await resolveClan(clan, { deadlineAt });
                summary.attempted += 1;
                summary.levelUps += result.advanced?.ok ? 1 : 0;
                summary.contributions += result.warehouse?.deposited || 0;
                summary.blocked += result.warehouse?.blocked || 0;
            }
            if (summary.levelUps > 0) await ClanService.reload();
            DiagnosticConfig.developerDiagnostics && (metrics.resolves += summary.attempted);
            return summary;
        });
    },

    metrics() {
        if (!DiagnosticConfig.developerDiagnostics) return { enabled: false };
        return {
            resolves: metrics.resolves,
            contributionsBlocked: metrics.contributionsBlocked,
            levelUps: metrics.levelUps,
            budgetStops: metrics.budgetStops,
            reasonCounts: Object.fromEntries(metrics.reasonCounts.entries())
        };
    },

    resetMetrics() {
        Object.keys(metrics).forEach((key) => {
            if (metrics[key] instanceof Map) metrics[key].clear();
            else metrics[key] = 0;
        });
    }
};

module.exports = ClanEconomyService;
