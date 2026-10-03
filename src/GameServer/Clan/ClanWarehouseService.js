const Crafting = require('./ClanCraftingPolicy');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const cursors = new Map();
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

async function depositHot(member, clan, rows, demand, limit, goalKey) {
    const session = invoke('GameServer/Bot/BotManager').findSessionById(member.characterId);
    const actor = session?.actor;
    if (!actor?.backpack || Number(actor.fetchClanId?.()) !== Number(clan.id)
        || actor.isDead?.() || actor.state?.fetchHits?.() || actor.state?.fetchCasts?.()
        || session.activeTrade || session.trade || session.activeNegotiation || session.botTradeReservations?.size
        || actor.fetchPrivateStoreType?.()) return [];
    await invoke('GameServer/Persistence/CharacterWriteQueue').flushCharacter(member.characterId);
    const items = actor.backpack.fetchItems();
    const snapshots = items.map(item => ({ id: item.fetchId(), selfId: item.fetchSelfId(), amount: item.fetchAmount(),
        kind: item.fetchKind(), name: item.fetchName(), equipped: item.fetchEquipped?.(), enchant: item.fetchEnchantLevel?.() || 0 }));
    const candidates = Policy.depositCandidates(member, snapshots, rows, { ...Config, demand, goalKey }).slice(0, limit);
    if (!candidates.length) return [];
    const results = await Database.transferPlayerInventoryBatchToClanWarehouse({ clanId: clan.id, characterId: member.characterId,
        transfers: candidates.map(item => ({ item, amount: item.amount,
            resolveKey: `${clan.id}:hot-supplies:${member.characterId}:${item.id}:${Date.now()}` })) });
    for (const result of results) {
        const item = items.find(item => Number(item.fetchId()) === Number(result.sourceItemId));
        if (!item) continue;
        if (Number(result.inventoryAmount) > 0) item.setAmount(result.inventoryAmount);
        else actor.backpack.items = actor.backpack.items.filter(entry => entry !== item);
    }
    session.dataSendToMe?.(invoke('GameServer/Network/Response').itemsList(actor.backpack.fetchItems()));
    return candidates;
}

async function resolveClan(clan, options = {}) {
    if (!clan || !number(clan.id)) {
        return { ok: true, skipped: true, reason: 'warehouse_level_unavailable' };
    }
    const deadlineAt = Number.isFinite(Number(options.deadlineAt)) ? Number(options.deadlineAt) : Infinity;
    const batchSize = Math.max(1, Math.min(32, number(options.batchSize, Config.warehouseDepositBatchSize)));
    const warehouseRows = await Database.fetchClanWarehouseItems(clan.id);
    let members = (clan.members || []).filter((member) => (
        ['cold', 'hot'].includes(member.phase)
        && !BotServiceIdentity.isStaticService(member)
        && number(member.characterId) > 0
    ));
    const goal = clan.state?.goal?.type === 'equipment' || clan.state?.goal?.policy?.strategy === 'craft'
        ? clan.state.goal : clan.state?.productionGoal || clan.state?.goal;
    const beneficiary = (clan.members || []).find(member => number(member.characterId) === number(goal?.target?.memberId));
    const plan = beneficiary?.stats?.equipmentPlan;
    const demand = goal?.policy?.strategy === 'craft'
        ? Object.fromEntries((goal.plan?.craft?.materials || []).map(material => [material.selfId, material.required]))
        : plan?.strategy === 'craft' && plan.clanGoal?.goalKey === goal?.goalKey
        ? Object.fromEntries([...Crafting.requirements(Crafting.resolveRecipe(plan.recipeId), beneficiary.inventory, null, 1, plan.craftProviders, plan.componentRecipes)]
            .map(([id, amount]) => [id, Math.max(0, amount - number(beneficiary.inventory?.[id]?.amount))])) : {};
    const cursor = cursors.get(number(clan.id)) || 0;
    members = [...members.filter(member => member.characterId > cursor), ...members.filter(member => member.characterId <= cursor)];
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
        cursors.set(number(clan.id), number(member.characterId));
        if (cursors.size > 128) cursors.delete(cursors.keys().next().value);
        if (member.phase === 'hot') {
            try {
                const moved = await depositHot(member, clan, warehouseRows, demand, batchSize - attempted, goal?.goalKey);
                attempted += moved.length;
                deposited += moved.length;
                units += moved.reduce((sum, item) => sum + item.amount, 0);
                if (moved.length) {
                    warehouseRows.splice(0, warehouseRows.length, ...await Database.fetchClanWarehouseItems(clan.id));
                    const [row] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [clan.id]]);
                    warehouseRevision = number(JSON.parse(row.stateJson).warehouseRevision);
                }
            } catch (error) { blocked++; recordReason('hot_supplies_deferred'); }
            continue;
        }
        const supplyIds = Object.values(member.inventory || {})
            .filter(item => Policy.isClanWarehouseCandidate(item, { ...Config, demand }))
            .map(item => Number(item.selfId));
        if (member.simulationOwner === 'cold_simulation_owner' && !supplyIds.length) continue;
        if (Database.materializeClanSupplies && !await Database.materializeClanSupplies(member.characterId, member.simulationRevision, supplyIds)) continue;
        const items = await Database.fetchItems(member.characterId);
        const candidates = Policy.depositCandidates(member, items, warehouseRows, { ...Config, demand, goalKey: goal?.goalKey });
        for (const candidate of candidates) {
            if (Date.now() >= deadlineAt || attempted >= batchSize) {
                budgetStopped = Date.now() >= deadlineAt;
                if (budgetStopped) metrics.budgetStops += 1;
                break;
            }
            attempted += 1;
            const result = await (LifeState.applyClanMaterialTransfer ? LifeState.applyClanMaterialTransfer.bind(LifeState) : Database.transferInventoryToClanWarehouse)({
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

    const nextId = number(plan?.next?.itemId);
    const needed = number(plan?.next?.requiredTotal || plan?.next?.amount, 1);
    const nextAvailable = warehouseRows.filter(row => number(row.selfId) === nextId)
        .reduce((sum, row) => sum + Math.max(0, number(row.amount) - number(row.reservedAmount)), 0);
    if (deposited && nextId && nextAvailable + number(beneficiary?.inventory?.[nextId]?.amount) >= needed) {
        await Database.execute([`UPDATE clan_actions SET availableAt = MIN(availableAt, ?)
            WHERE clanId = ? AND actionType IN ('goal_plan', 'production') AND status = 'pending'`, [Date.now(), clan.id]], 'clan-supplies:ready');
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
