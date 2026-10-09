const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const short = value => typeof value === 'string' ? value.slice(0, 160) : null;

function wish(key, itemFor, inventory = {}, wishName = () => null) {
    if (!key) return null;
    const [kind, reference, qualifier] = String(key).split(':');
    let itemId = ['power', 'status', 'resale', 'item'].includes(kind) ? Number(reference) : 0;
    if (['enchant', 'sa'].includes(kind)) itemId = Number(Object.values(inventory)
        .find(item => item.instances?.some(instance => Number(instance.id) === Number(reference)))?.selfId || 0);
    return { key: short(key), kind, reference: short(reference), qualifier: short(qualifier), name: short(wishName(kind, reference)),
        item: itemId > 0 ? itemFor(itemId) : null };
}

function goal(plan, itemFor) {
    if (!plan) return null;
    return { status: short(plan.status), phase: short(plan.phase), reason: short(plan.reason),
        target: Number(plan.target?.selfId) > 0 ? itemFor(Number(plan.target.selfId)) : null,
        next: plan.next ? { kind: short(plan.next.kind || plan.next.sourceKind),
            npcId: finite(plan.next.npcId), npcName: short(plan.next.npcName),
            spotId: short(plan.next.spotId), town: short(plan.next.town), recipeId: finite(plan.next.recipeId),
            amount: finite(plan.next.amount), item: Number(plan.next.itemId) > 0 ? itemFor(Number(plan.next.itemId)) : null,
            raidBoss: !!plan.next.raidBoss } : null, requiresParty: !!plan.requiresParty };
}

function project(state, { itemFor = id => ({ selfId: id, name: `Item ${id}` }), wishName = () => null, activity = null } = {}) {
    const stats = state?.stats || {}, focus = stats.wishFocus, money = stats.money;
    const funded = [];
    if (Array.isArray(money)) for (let i = 4, previous = 0; i + 2 < Math.min(money.length, 28); i += 3) {
        const cumulative = Math.max(0, finite(money[i + 1]) || 0);
        funded.push({ hoursPerAdena: finite(money[i]), cumulativeCost: cumulative,
            cost: Math.max(0, cumulative - previous), item: Number(money[i + 2]) > 0 ? itemFor(Number(money[i + 2])) : null });
        previous = cumulative;
    }
    return {
        updatedAt: state?.updatedAt || null,
        focus: Array.isArray(focus) ? { ...wish(focus[0], itemFor, state.inventory, wishName),
            sincePlayedHours: finite(focus[1]), estimatedPrice: finite(focus[2]) } : null,
        dormant: (Array.isArray(stats.dormantWishes) ? stats.dormantWishes : []).slice(0, 4).filter(Array.isArray).map(row => ({
            ...wish(row[0], itemFor, state.inventory, wishName), reason: short(row[1]), estimatedPrice: finite(row[3]),
            atPlayedHours: finite(row[4]) })),
        money: Array.isArray(money) && money.length >= 4 ? { wallet: finite(state.adena),
            adenaPerHour: finite(money[0]), hoursPerAdena: finite(money[1]), survivalReserve: finite(money[2]),
            firstUnfundedPrice: finite(money[3]), funded } : null,
        selectedAction: activity ? {
            root: wish(activity.rootKey, itemFor, state.inventory, wishName), inputKey: short(activity.nodeKey),
            activity: short(activity.activity), source: short(activity.sourceType || activity.kind),
            item: Number(activity.itemId) > 0 ? itemFor(Number(activity.itemId)) : null,
            amount: finite(activity.amount), npcId: finite(activity.npcId), town: short(activity.town), recipeId: finite(activity.recipeId),
            spotId: short(activity.spotId), funding: !!activity.funding, estimatedPrice: finite(activity.price),
            effortHours: finite(activity.effort), shortfall: finite(activity.shortfall)
        } : null,
        acquisitionGoal: goal(stats.acquisitionGoal || stats.goal, itemFor),
        equipmentPlan: goal(stats.equipmentPlan, itemFor)
    };
}
module.exports = { project };
