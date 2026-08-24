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
    contributionsApplied: 0,
    contributionsBlocked: 0,
    noDisposable: 0,
    levelUps: 0,
    amountContributed: 0,
    budgetStops: 0,
    reasonCounts: new Map()
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
    if (code) metrics.reasonCounts.set(code, (metrics.reasonCounts.get(code) || 0) + 1);
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

async function resolveClan(clan, options = {}) {
    if (!clan || number(clan.level) < 0 || number(clan.level) > 3) {
        return { ok: true, skipped: true, reason: 'level_out_of_slice' };
    }
    const targetLevel = number(clan.level);
    if (targetLevel >= 1) {
        let contributionResult = {
            ok: true,
            skipped: targetLevel !== 1,
            reason: targetLevel === 1 ? null : 'level_two_contributions_deferred'
        };
        if (targetLevel === 1) {
            const requiredAmount = Policy.scaledAdenaRequirement(targetLevel);
            const summary = (await Database.fetchClanContributionSummary(clan.id, targetLevel))[0]
                || { amount: 0, entries: 0 };
            const contributedAmount = number(summary.amount);
            const candidates = clan.members.filter((member) => (
                member.phase === 'cold'
                && number(member.characterId) !== number(clan.leaderId)
                && !BotServiceIdentity.isStaticService(member)
            ));
            const plan = Policy.planContributions(candidates, {
                leaderId: clan.leaderId,
                requiredAmount,
                contributedAmount,
                config: Config
            });
            const results = [];
            let warehouseRevision = number(clan.state?.warehouseRevision);
            const bucket = Math.floor(Date.now() / Math.max(1000, Number(Config.resolveIntervalMs) || 60000));
            const batchSize = Math.max(1, Math.min(32, number(options.batchSize, Config.contributionBatchSize)));
            for (const contribution of plan.contributions.slice(0, batchSize)) {
                const member = candidates.find((entry) => Number(entry.characterId) === Number(contribution.characterId));
                const result = await Database.transferClanAdenaToWarehouse({
                    clanId: clan.id,
                    characterId: contribution.characterId,
                    targetLevel,
                    amount: contribution.amount,
                    reserve: contribution.reserve,
                    maxContributionFraction: Config.contributionMaxFraction,
                    expectedWarehouseRevision: warehouseRevision,
                    expectedSimulationRevision: member?.simulationRevision,
                    resolveKey: `${clan.id}:${targetLevel}:warehouse:${contribution.characterId}:${bucket}`
                });
                results.push(result);
                if (result.ok) {
                    metrics.contributionsApplied += 1;
                    metrics.amountContributed += number(result.amount);
                    warehouseRevision = number(result.warehouseRevision, warehouseRevision);
                    if (member) member.simulationRevision = number(result.simulationRevision, member.simulationRevision);
                    recordReason(Contracts.REASON_CODES.CONTRIBUTION_APPLIED);
                } else {
                    metrics.contributionsBlocked += 1;
                    recordReason(result.code);
                    if (result.code === Contracts.REASON_CODES.CONTRIBUTION_NO_DISPOSABLE_ADENA) metrics.noDisposable += 1;
                }
            }

            const after = (await Database.fetchClanContributionSummary(clan.id, targetLevel))[0]
                || { amount: contributedAmount, entries: 0 };
            let advanced = { ok: false, code: Contracts.REASON_CODES.CONTRIBUTION_LEVEL_READY };
            if (number(after.amount) >= requiredAmount) {
                advanced = await Database.advanceAutonomousClanLevel({
                    clanId: clan.id,
                    fromLevel: targetLevel,
                    toLevel: targetLevel + 1,
                    requiredAmount
                });
                if (advanced.ok) {
                    metrics.levelUps += 1;
                    await ClanCrestService.ensureAutonomousCrest(clan.id);
                    recordReason(Contracts.REASON_CODES.CONTRIBUTION_LEVEL_UP);
                }
            }
            contributionResult = {
                ok: true,
                clanId: clan.id,
                level: targetLevel,
                requiredAmount,
                contributedAmount: number(after.amount),
                shortfall: Math.max(0, requiredAmount - number(after.amount)),
                plan,
                results,
                advanced,
                warehouseRevision
            };
        }

        if (contributionResult.warehouseRevision !== undefined) {
            clan.state = {
                ...(clan.state || {}),
                warehouseRevision: number(contributionResult.warehouseRevision)
            };
        }

        const warehouse = await ClanWarehouseService.resolveClan(clan, {
            batchSize: Config.warehouseDepositBatchSize,
            deadlineAt: Number.isFinite(Number(options.deadlineAt)) ? Number(options.deadlineAt) : Infinity
        });
        return {
            ...contributionResult,
            warehouse,
            advanced: contributionResult.advanced || { ok: false }
        };
    }

    const requiredAmount = Policy.scaledAdenaRequirement(targetLevel);
    const summary = (await Database.fetchClanContributionSummary(clan.id, targetLevel))[0]
        || { amount: 0, entries: 0 };
    const contributedAmount = number(summary.amount);
    if (contributedAmount >= requiredAmount) {
        const advanced = await Database.advanceAutonomousClanLevel({
            clanId: clan.id,
            fromLevel: targetLevel,
            toLevel: targetLevel + 1,
            requiredAmount
        });
        if (advanced.ok) {
            metrics.levelUps += 1;
            await ClanCrestService.ensureAutonomousCrest(clan.id);
            recordReason(Contracts.REASON_CODES.CONTRIBUTION_LEVEL_UP);
        }
        return { ...advanced, requiredAmount, contributedAmount };
    }

    const candidates = clan.members.filter((member) => (
        member.phase === 'cold'
        && number(member.characterId) !== number(clan.leaderId)
        && !BotServiceIdentity.isStaticService(member)
    ));
    const plan = Policy.planContributions(candidates, {
        leaderId: clan.leaderId,
        requiredAmount,
        contributedAmount,
        config: Config
    });
    const results = [];
    const bucket = Math.floor(Date.now() / Math.max(1000, Number(Config.resolveIntervalMs) || 60000));
    const batchSize = Math.max(1, Math.min(32, number(options.batchSize, Config.contributionBatchSize)));
    for (const contribution of plan.contributions.slice(0, batchSize)) {
        const result = await Database.transferClanAdena({
            clanId: clan.id,
            characterId: contribution.characterId,
            leaderId: clan.leaderId,
            targetLevel,
            amount: contribution.amount,
            reserve: contribution.reserve,
            maxContributionFraction: Config.contributionMaxFraction,
            resolveKey: `${clan.id}:${targetLevel}:${contribution.characterId}:${bucket}`
        });
        results.push(result);
        if (result.ok) {
            metrics.contributionsApplied += 1;
            metrics.amountContributed += number(result.amount);
            recordReason(Contracts.REASON_CODES.CONTRIBUTION_APPLIED);
        } else {
            metrics.contributionsBlocked += 1;
            recordReason(result.code);
            if (result.code === Contracts.REASON_CODES.CONTRIBUTION_NO_DISPOSABLE_ADENA) metrics.noDisposable += 1;
        }
    }

    const after = (await Database.fetchClanContributionSummary(clan.id, targetLevel))[0]
        || { amount: contributedAmount, entries: 0 };
    let advanced = { ok: false, code: Contracts.REASON_CODES.CONTRIBUTION_LEVEL_READY };
    if (number(after.amount) >= requiredAmount) {
        advanced = await Database.advanceAutonomousClanLevel({
            clanId: clan.id,
            fromLevel: targetLevel,
            toLevel: targetLevel + 1,
            requiredAmount
        });
        if (advanced.ok) {
            metrics.levelUps += 1;
            recordReason(Contracts.REASON_CODES.CONTRIBUTION_LEVEL_UP);
        }
    }
    return {
        ok: true,
        clanId: clan.id,
        level: targetLevel,
        requiredAmount,
        contributedAmount: number(after.amount),
        shortfall: Math.max(0, requiredAmount - number(after.amount)),
        plan,
        results,
        advanced
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
                    metrics.budgetStops += 1;
                    summary.budgetStopped = true;
                    break;
                }
                const result = await resolveClan(clan, {
                    batchSize: Config.contributionBatchSize,
                    deadlineAt
                });
                summary.attempted += 1;
                summary.levelUps += result.advanced?.ok ? 1 : 0;
                summary.contributions += (result.results || []).filter((entry) => entry.ok).length;
                summary.contributions += result.warehouse?.deposited || 0;
                summary.blocked += (result.results || []).filter((entry) => !entry.ok).length;
                summary.blocked += result.warehouse?.blocked || 0;
            }
            if (summary.levelUps > 0) await ClanService.reload();
            metrics.resolves += summary.attempted;
            return summary;
        });
    },

    metrics() {
        return {
            resolves: metrics.resolves,
            contributionsApplied: metrics.contributionsApplied,
            contributionsBlocked: metrics.contributionsBlocked,
            noDisposable: metrics.noDisposable,
            levelUps: metrics.levelUps,
            amountContributed: metrics.amountContributed,
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
