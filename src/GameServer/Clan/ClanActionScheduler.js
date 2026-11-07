'use strict';

const key = 'clanActionScheduler:v1';
const list = value => Array.isArray(value) ? value : [];

function select(actions, saved = {}, at) {
    const active = new Map(actions.map(action => [Number(action.id), action]));
    const continuations = [...new Set(list(saved.continuations).map(Number))].filter(id => active.has(id));
    const continuing = new Set(continuations);
    const groups = new Map();
    const score = action => Number(action.priority) + Math.floor(Math.max(0, at - action.availableAt) / 60000);
    const compare = (left, right) => score(right) - score(left)
        || left.availableAt - right.availableAt || left.id - right.id;
    for (const action of actions) {
        if (!groups.has(action.actionType)) groups.set(action.actionType, []);
        if (action.status === 'pending' && action.availableAt <= at) groups.get(action.actionType).push(action);
    }
    for (const ready of groups.values()) ready.sort(compare);
    const order = [...new Set(list(saved.order))].filter(type => groups.has(type));
    // New types join the round once. Priority decides their initial order,
    // then every ready type receives one turn before the same type returns.
    const added = [...groups.keys()].filter(type => !order.includes(type)).sort((left, right) => {
        const a = groups.get(left)[0], b = groups.get(right)[0];
        return a && b ? compare(a, b) : a ? -1 : b ? 1 : 0;
    });
    order.push(...added);
    const resumed = new Map(order.map(type => [type, saved.resumed?.[type] === true]));
    const type = order.find(type => groups.get(type).length > 0);
    if (type === undefined) return { actionId: null };
    const ready = groups.get(type), readyIds = new Set(ready.map(action => Number(action.id)));
    const continuation = continuations.find(id => readyIds.has(id));
    const ordinary = ready.find(action => !continuing.has(Number(action.id)));
    // Resume work promptly, but alternate with ordinary work while both are
    // ready. A pending LLM or warehouse stage cannot own every turn forever.
    const resume = continuation !== undefined && (!resumed.get(type) || !ordinary);
    const actionId = resume ? continuation : Number(ordinary.id);
    const before = { order, resumed: Object.fromEntries(resumed) };
    resumed.set(type, resume);
    return { actionId, before, state: {
        order: [...order.filter(entry => entry !== type), type],
        continuations,
        resumed: Object.fromEntries(resumed)
    } };
}

function recordClaim(selection, action) {
    return { ...selection.state, claim: { id: Number(action.id), attempt: Number(action.attempt),
        leaseUntil: Number(action.leaseUntil), before: selection.before } };
}

function refundClaim(saved, action) {
    const receipt = saved.claim;
    // A refund belongs only to the exact latest lease. Never rewind another
    // admission, and retain continuations published since this claim.
    if (!receipt || receipt.id !== Number(action.id) || receipt.attempt !== Number(action.attempt)
        || receipt.leaseUntil !== Number(action.leaseUntil)) return saved;
    const { claim, ...current } = saved;
    return { ...current, order: receipt.before.order, resumed: receipt.before.resumed };
}

function continueAction(saved = {}, actionId) {
    const id = Number(actionId);
    return { ...saved, continuations: [...list(saved.continuations).map(Number).filter(entry => entry !== id), id] };
}

module.exports = { key, select, recordClaim, refundClaim, continueAction };
