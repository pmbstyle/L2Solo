const Database = invoke('Database');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const Policy = invoke('GameServer/Clan/ClanWarehousePolicy');
const BotServiceIdentity = invoke('GameServer/Bot/AI/BotServiceIdentity');

const metrics = {
    resolves: 0,
    depositsApplied: 0,
    depositsBlocked: 0,
    materials: 0,
    recipes: 0,
    progressionItems: 0,
    reservationConflicts: 0,
    budgetStops: 0,
    reasonCounts: new Map()
};

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function recordReason(code) {
    if (code) metrics.reasonCounts.set(code, (metrics.reasonCounts.get(code) || 0) + 1);
}

async function resolveClan(clan, options = {}) {
    if (!clan || number(clan.level) < 1 || number(clan.level) > 3) {
        return { ok: true, skipped: true, reason: 'warehouse_level_unavailable' };
    }
    const deadlineAt = Number.isFinite(Number(options.deadlineAt)) ? Number(options.deadlineAt) : Infinity;
    const batchSize = Math.max(1, Math.min(32, number(options.batchSize, Config.warehouseDepositBatchSize)));
    const warehouseRows = await Database.fetchClanWarehouseItems(clan.id);
    const members = (clan.members || []).filter((member) => (
        member.phase === 'cold'
        && !BotServiceIdentity.isStaticService(member)
        && number(member.characterId) > 0
    ));
    let warehouseRevision = number(clan.state?.warehouseRevision);
    let attempted = 0;
    let deposited = 0;
    let blocked = 0;
    let units = 0;
    let budgetStopped = false;
    const results = [];
    const bucket = Math.floor(Date.now() / Math.max(1000, number(Config.resolveIntervalMs, 60000)));

    for (const member of members) {
        if (Date.now() >= deadlineAt || attempted >= batchSize) {
            budgetStopped = Date.now() >= deadlineAt;
            if (budgetStopped) metrics.budgetStops += 1;
            break;
        }
        const items = await Database.fetchItems(member.characterId);
        const candidates = Policy.depositCandidates(member, items, warehouseRows, Config);
        for (const candidate of candidates) {
            if (Date.now() >= deadlineAt || attempted >= batchSize) {
                budgetStopped = Date.now() >= deadlineAt;
                if (budgetStopped) metrics.budgetStops += 1;
                break;
            }
            attempted += 1;
            const result = await Database.transferInventoryToClanWarehouse({
                clanId: clan.id,
                characterId: member.characterId,
                item: candidate,
                amount: candidate.amount,
                expectedWarehouseRevision: warehouseRevision,
                expectedSimulationRevision: member.simulationRevision,
                resolveKey: `${clan.id}:warehouse:${member.characterId}:${candidate.id}:${bucket}`
            });
            results.push(result);
            if (result.ok) {
                deposited += 1;
                units += number(result.amount);
                warehouseRevision = number(result.warehouseRevision, warehouseRevision);
                member.simulationRevision = number(result.simulationRevision, member.simulationRevision);
                const stored = warehouseRows.find((row) => Number(row.selfId) === Number(candidate.selfId)
                    && Number(row.enchant || 0) === Number(candidate.enchant || 0));
                if (stored) stored.amount = number(stored.amount) + number(result.amount);
                else warehouseRows.push({
                    selfId: candidate.selfId,
                    name: candidate.name,
                    kind: candidate.kind,
                    amount: number(result.amount),
                    enchant: candidate.enchant || 0,
                    reservedAmount: 0
                });
                if (candidate.reason === 'recipe') metrics.recipes += 1;
                else if (candidate.reason === 'progression_item') metrics.progressionItems += 1;
                else metrics.materials += 1;
                recordReason(result.code);
            } else {
                blocked += 1;
                if (result.code === 'warehouse_item_reserved' || result.code === 'ownership_conflict') metrics.reservationConflicts += 1;
                recordReason(result.code);
            }
        }
    }

    metrics.resolves += 1;
    metrics.depositsApplied += deposited;
    metrics.depositsBlocked += blocked;
    return {
        ok: true,
        clanId: number(clan.id),
        level: number(clan.level),
        attempted,
        deposited,
        blocked,
        units,
        warehouseRevision,
        budgetStopped,
        results
    };
}

const ClanWarehouseService = {
    config: Config,
    policy: Policy,
    resolveClan,

    resolveBatch(clans = [], options = {}) {
        const deadlineAt = Date.now() + Math.max(1, number(options.budgetMs, Config.resolveBudgetMs));
        return Promise.resolve(clans).then(async (entries) => {
            const summary = { attempted: 0, deposited: 0, blocked: 0, units: 0, budgetStopped: false };
            for (const clan of entries || []) {
                if (Date.now() >= deadlineAt) {
                    summary.budgetStopped = true;
                    metrics.budgetStops += 1;
                    break;
                }
                const result = await resolveClan(clan, {
                    deadlineAt,
                    batchSize: Config.warehouseDepositBatchSize
                });
                summary.attempted += result.attempted || 0;
                summary.deposited += result.deposited || 0;
                summary.blocked += result.blocked || 0;
                summary.units += result.units || 0;
                summary.budgetStopped = summary.budgetStopped || !!result.budgetStopped;
            }
            return summary;
        });
    },

    metrics() {
        return {
            resolves: metrics.resolves,
            depositsApplied: metrics.depositsApplied,
            depositsBlocked: metrics.depositsBlocked,
            materials: metrics.materials,
            recipes: metrics.recipes,
            progressionItems: metrics.progressionItems,
            reservationConflicts: metrics.reservationConflicts,
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

module.exports = ClanWarehouseService;
