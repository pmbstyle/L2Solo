'use strict';

// Retain physical inputs of the selected native craft or equipment exchange DAG.
// A missing recipe/material remains an errand; it does not release the
// ingredients already collected toward that profitable equipment funding.

// The selected root's craft inputs before the bag caps them: [id, need]
// rows by id. One walk per build: the compact network keeps them (craftNeeds).
function selectedCraftNeeds(network) {
    const root = network?.activity?.rootKey || network?.focus?.[0];
    const plan = network?.queue?.find(row => row.key === root)?.plan || network?.plans?.get(root);
    const needs = new Map(), visited = new Set();
    function visit(node) {
        if (!node || visited.has(node)) return;
        visited.add(node);
        // A crystallization's source gear is an input as a recipe's material is: bought for
        // the conversion, it is not offered for sale before it is crystallized.
        if (['craft', 'luxury_exchange', 'mammon_unseal', 'crystallize'].includes(node.kind)) for (const row of node.grossRequirements || node.requirements || []) {
            const id = Number(String(row.key).replace(/^item:/, ''));
            if (!id) continue;
            const count = Number(row.amount || 0) * (row.once ? 1 : Math.max(1, Number(node.batches || 1)));
            needs.set(id, (needs.get(id) || 0) + count);
        }
        for (const row of node.requirements || []) visit(row.plan || network.plans?.get(row.key));
    }
    visit(plan);
    return [...needs].sort((a, b) => a[0] - b[0]);
}
// The needs capped by the bag the reader reads: {id: amount}. A built network and a
// card's view carry the needs (craftNeeds) and are capped here, never at the decision:
// an input bought after it is the craft's as one held then.
function selectedCraftAmounts(state, network) {
    const reserved = {};
    for (const [id, need] of network?.craftNeeds || selectedCraftNeeds(network)) reserved[id] = Math.min(Number(state.inventory?.[id]?.amount || 0), need);
    return reserved;
}
// The held units of given needs as [id, amount] rows: the held build's craft inputs.
function heldCraftRows(state, needs) {
    const rows = [];
    for (const [id, need] of needs || []) {
        const amount = Math.min(Number(state.inventory?.[id]?.amount || 0), need);
        if (amount > 0) rows.push([id, amount]);
    }
    return rows;
}

module.exports = { selectedCraftNeeds, selectedCraftAmounts, heldCraftRows };
