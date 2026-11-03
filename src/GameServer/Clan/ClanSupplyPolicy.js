'use strict';
const { isMainThread } = require('node:worker_threads');
const { createHash } = require('node:crypto');
let ClanCraftingPolicyModule = null;
// lazy: order ClanCraftingPolicy reads the item catalogs at load; tests load this file before them. Resolved once.
const craftingPolicy = () => ClanCraftingPolicyModule ??= require('./ClanCraftingPolicy');
const ClanHallPolicy = require('../ClanHall/Policy');
const CONTENT_IDENTITY = Symbol('clan_supply_content_identity');
const REQUEST_IDENTITY = Symbol('clan_supply_request_identity');
const NO_CLAN_IDENTITY = createHash('sha256').update('[0,[]]').digest('hex');
const records = new Map();
const stocks = new Map();
let source = id => records.get(id);
let revision = 0;
let initialized = false, sourceReady = () => initialized;
function prepareRow(row) {
    const valid = Array.isArray(row) && row.length === 4 && Number.isSafeInteger(row[0]) && row[0] > 0
        && Number.isSafeInteger(row[1]) && row[1] >= 0 && Array.isArray(row[2]) && row[2].length <= 128
        && row[2].every(value => Array.isArray(value) && value.length === 2
            && Number.isSafeInteger(value[0]) && value[0] > 0 && Number.isSafeInteger(value[1]) && value[1] > 0);
    if (!valid) {
        if (row && typeof row === 'object') { delete row[CONTENT_IDENTITY]; delete row[REQUEST_IDENTITY]; }
        return row;
    }
    if (!Object.hasOwn(row, CONTENT_IDENTITY)) Object.defineProperty(row, CONTENT_IDENTITY,
        { configurable: true, value: createHash('sha256').update(JSON.stringify([row[1], row[2]])).digest('hex') });
    if (!Object.hasOwn(row, REQUEST_IDENTITY)) Object.defineProperty(row, REQUEST_IDENTITY,
        { configurable: true, value: `${row[1]}:${row[2].map(value => value[0]).sort((a, b) => a - b).join()}` });
    return row;
}
const positive = value => Math.max(0, Math.floor(Number(value) || 0));
const active = goal => goal && !['completed', 'cancelled', 'failed', 'abandoned'].includes(goal.status)
    && !(positive(goal.required) && Number(goal.progress) >= Number(goal.required));
function requirements(clan, warehouse = null) {
    const demand = new Map(), seen = new Set(), goals = [clan?.state?.goal, clan?.state?.productionGoal].filter(active);
    if (!(Number(clan?.level) >= 1)) return {};
    for (const goal of goals) {
        if (goal.goalKey && seen.has(goal.goalKey)) continue;
        if (goal.goalKey) seen.add(goal.goalKey);
        const beneficiary = (clan.members || []).find(member => Number(member.characterId ?? member.id) === Number(goal.target?.memberId));
        const plan = beneficiary?.stats?.equipmentPlan;
        let materials = [];
        if (goal.policy?.strategy === 'craft' && goal.plan?.craft?.materials?.length) materials = goal.plan.craft.materials
            .map(row => [Number(row.selfId), positive(row.required ?? row.amount)]);
        else if (plan?.strategy === 'craft' && plan.clanGoal?.goalKey === goal.goalKey) {
            materials = [...craftingPolicy().requirements(craftingPolicy().resolveRecipe(plan.recipeId), beneficiary.inventory,
                null, 1, plan.craftProviders, plan.componentRecipes)].map(([id, amount]) =>
                [id, Math.max(0, amount - positive(beneficiary.inventory?.[id]?.amount))]);
        } else if (goal.policy?.strategy !== 'craft' && (goal.type === 'item' || goal.type === 'equipment')) {
            const id = Number(goal.target?.itemId ?? goal.target?.selfId);
            const item = invoke('GameServer/Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, id);
            const unit = invoke('GameServer/Items/NpcSellRules').npcBuyPrice(item?.template?.price);
            let amount = Math.max(0, positive(goal.required || 1) - positive(goal.progress));
            if (warehouse) {
                const budget = ClanHallPolicy.freeAdena(warehouse, clan,
                    clan.state?.mode || 'autonomous', goal === clan.state?.goal ? null : clan.state?.goal);
                amount = Math.min(amount, unit > 0 ? Math.floor(budget / unit) : 0);
            }
            if (id > 0 && unit > 0) materials = [[id, amount]];
        }
        for (const [id, amount] of materials) if (id > 0 && amount > 0)
            demand.set(id, positive(demand.get(id)) + amount);
    }
    for (const row of warehouse || []) demand.set(Number(row.selfId), Math.max(0,
        positive(demand.get(Number(row.selfId))) - positive(row.amount)));
    return Object.fromEntries([...demand].filter(([, amount]) => amount > 0).slice(0, 128));
}
function publish(clan, warehouse) {
    if (!isMainThread || !(Number(clan?.id) > 0)) return;
    if (warehouse) stocks.set(Number(clan.id), warehouse.map(row => ({ selfId: row.selfId,
        amount: row.amount, reservedAmount: row.reservedAmount })));
    warehouse = warehouse || stocks.get(Number(clan.id)) || [];
    const row = [Number(clan.id), Number(clan.level), Object.entries(requirements(clan, warehouse)).map(([id, amount]) => [Number(id), amount])];
    const previous = records.get(row[0]);
    if (JSON.stringify(previous?.slice(0, 3)) === JSON.stringify(row)) return;
    row.push(++revision);
    prepareRow(row);
    records.set(row[0], row);
    // lazy: worker only the main clan projection publishes readiness.
    require('../Bot/Population/ColdTableChannel').shared.changed('clan_supplies', row);
}
function reservedAmounts(state = {}) {
    const id = Number(state.clanId ?? state.stats?.clanId);
    const row = source(id);
    if (!(id > 0) || !(Number(row?.[1]) >= 1)) return {};
    return Object.fromEntries(row[2] || []);
}
function hasWarehouse(state = {}) {
    if (Number.isFinite(state.clanLevel)) return state.clanLevel >= 1;
    return Number(source(Number(state.clanId ?? state.stats?.clanId))?.[1]) >= 1;
}
async function init() {
    if (!isMainThread) return;
    const rows = await invoke('Database').execute(['SELECT id, level FROM clans', []], 'clan-supplies:levels');
    for (const row of rows) publish({ ...row, state: {} });
}
// lazy: worker only the main clan projection publishes readiness.
if (isMainThread) require('../Bot/Population/ColdTableChannel').shared.register('clan_supplies', {
    key: row => row[0], allRows: () => records.values(), eventDriven: true, ready: () => initialized
});
module.exports = { requirements, publish, reservedAmounts, hasWarehouse, init, prepareRow,
    ready() { return sourceReady() === true; },
    projectionReady() {
        if (!isMainThread || initialized) return;
        initialized = true;
        // lazy: worker only the main clan projection publishes readiness.
        require('../Bot/Population/ColdTableChannel').shared.flush();
    },
    contentIdentity(state = {}) {
        const id = Number(state.clanId ?? state.stats?.clanId);
        if (!(id > 0)) return NO_CLAN_IDENTITY;
        if (sourceReady() !== true) return null;
        return source(id)?.[CONTENT_IDENTITY] ?? null;
    },
    // What a member hears of its clan's request: the items it names; a request
    // opening or closing moves it, a count left does not (Recompute: a crossing).
    requestIdentity(state = {}) {
        const id = Number(state.clanId ?? state.stats?.clanId);
        if (!(id > 0)) return NO_CLAN_IDENTITY;
        if (sourceReady() !== true) return null;
        return source(id)?.[REQUEST_IDENTITY] ?? null;
    },
    version(state = {}) { return Number(source(Number(state.clanId ?? state.stats?.clanId))?.[3] || 0); },
    useRowSource(reader, isReady) {
        source = reader || (id => records.get(id));
        sourceReady = reader ? (isReady || (() => false)) : () => initialized;
    } };
