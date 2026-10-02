const Crafting = require('./ClanCraftingPolicy');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const cursors = new Map();
const Database = invoke('Database');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const Policy = invoke('GameServer/Clan/ClanWarehousePolicy');
const BotServiceIdentity = invoke('GameServer/Bot/AI/BotServiceIdentity');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const DuesPolicy = invoke('GameServer/Clan/ClanContributionPolicy');
const ExchangePolicy = invoke('GameServer/Clan/ClanWarehouseEquipmentPolicy');

const HOUR = 60 * 60 * 1000;
// When each member next looks at its spare gear, and each clan's members' item rows.
const gearOfferAt = new Map();
const clanItemRows = new Map();

const metrics = {
    resolves: 0,
    depositsApplied: 0,
    depositsBlocked: 0,
    materials: 0,
    recipes: 0,
    progressionItems: 0,
    reservationConflicts: 0,
    gearOffered: 0,
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

async function memberRows(clan, characterId) {
    const cached = clanItemRows.get(number(clan.id));
    if (cached && Date.now() - cached.at < 5 * 60 * 1000 && cached.rows.has(characterId)) return cached.rows.get(characterId);
    const entry = cached && Date.now() - cached.at < 5 * 60 * 1000 ? cached : { at: Date.now(), rows: new Map() };
    entry.rows.set(characterId, await Database.fetchItems(characterId));
    clanItemRows.set(number(clan.id), entry);
    if (clanItemRows.size > 128) clanItemRows.delete(clanItemRows.keys().next().value);
    return entry.rows.get(characterId);
}

// A member about to sell spare gear first offers it to a clanmate who would wear
// it (the warehouse exchange's own test): for free or for a share of its market
// price by the giver's generosity; free to a friend, never to an enemy; full price
// while the giver saves for its own purchase. The clan pays the share from its
// free money, otherwise the giver sells as usual. The warehouse exchange then
// hands the item out. Once per member and hour; hot members are skipped.
async function offerSpareGear(clan, member, warehouseRevision) {
    const id = number(member.characterId);
    if (Date.now() < number(gearOfferAt.get(id))) return { deposited: 0, warehouseRevision };
    gearOfferAt.set(id, Date.now() + HOUR);
    if (gearOfferAt.size > 4096) gearOfferAt.delete(gearOfferAt.keys().next().value);
    const offers = ItemDisposition.saleCandidates(member, { unlimited: true })
        .filter((item) => ExchangePolicy.materialize({ id: -1, selfId: item.selfId, amount: 1 })?.isWearable());
    if (!offers.length) return { deposited: 0, warehouseRevision };
    const memory = invoke('GameServer/Social/InteractionMemoryRuntime');
    const giverTraits = invoke('GameServer/Bot/AI/BotPersona').snapshot(id)?.traits || {};
    const saving = DuesPolicy.ownGearPurchase(member) === 'short';
    const mates = (clan.members || []).filter((mate) => number(mate.characterId) !== id && mate.phase === 'cold');
    let deposited = 0;
    for (const offer of offers) {
        let best = null;
        for (const mate of mates) {
            const stance = memory.assess({ id }, { id: number(mate.characterId) }, {}, Date.now()).disposition;
            if (stance === 'hostile') continue;
            const fit = ExchangePolicy.plan(mate, await memberRows(clan, number(mate.characterId)), { selfId: offer.selfId, amount: 1, enchant: 0, reservedAmount: 0 });
            if (fit && (!best || fit.score > best.score)) best = { ...fit, stance };
        }
        if (!best) continue;
        const share = saving ? 1 : best.stance === 'friendly' ? 0 : DuesPolicy.askedShare(giverTraits);
        const price = Math.floor(number(offer.price) * share);
        if (price > 0) {
            const finance = await Database.fetchClanHallFinance(clan.id);
            if (!finance || number(finance.available) - number(finance.protected) < price) continue;
        }
        const row = (await Database.fetchItems(id)).find((item) => number(item.selfId) === offer.selfId && !item.equipped);
        if (!row) continue;
        const moved = await LifeState.applyClanMaterialTransfer({
            clanId: clan.id, characterId: id, item: row, amount: 1,
            expectedWarehouseRevision: warehouseRevision, expectedSimulationRevision: member.simulationRevision,
            resolveKey: `${clan.id}:gear-offer:${id}:${row.id}`
        });
        if (!moved.ok) { recordReason(moved.code); continue; }
        warehouseRevision = number(moved.warehouseRevision, warehouseRevision);
        member.simulationRevision = number(moved.simulationRevision, member.simulationRevision);
        deposited += 1;
        metrics.gearOffered += 1;
        if (price <= 0) continue;
        const paid = await LifeState.applyClanMaterialTransfer({
            clanId: clan.id, characterId: id, selfId: 57, amount: price, goalKey: `clan-gear-offer:${clan.id}:${id}:${row.id}`,
            expectedWarehouseRevision: warehouseRevision, expectedSimulationRevision: member.simulationRevision
        }, true);
        if (!paid.ok) { recordReason(paid.code); continue; }
        warehouseRevision = number(paid.warehouseRevision, warehouseRevision);
        member.simulationRevision = number(paid.simulationRevision, member.simulationRevision);
    }
    return { deposited, warehouseRevision };
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
    const goal = clan.state?.goal?.type === 'equipment' ? clan.state.goal : clan.state?.productionGoal || clan.state?.goal;
    const beneficiary = (clan.members || []).find(member => number(member.characterId) === number(goal?.target?.memberId));
    const plan = beneficiary?.stats?.equipmentPlan;
    const demand = plan?.strategy === 'craft' && plan.clanGoal?.goalKey === goal?.goalKey
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
        const gear = await offerSpareGear(clan, member, warehouseRevision);
        deposited += gear.deposited;
        warehouseRevision = gear.warehouseRevision;
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
