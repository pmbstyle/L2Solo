'use strict';

// Retain only physical inputs of the currently selected native craft DAG.
// A missing recipe/material remains an errand; it does not release the
// ingredients already collected toward that profitable equipment funding.
function selectedCraftAmounts(state, network) {
    const root = network?.activity?.rootKey || network?.focus?.[0];
    const plan = network?.queue?.find(row => row.key === root)?.plan || network?.plans?.get(root);
    const reserved = {}, visited = new Set();
    function visit(node) {
        if (!node || visited.has(node)) return;
        visited.add(node);
        if (node.kind === 'craft') for (const row of node.grossRequirements || node.requirements || []) {
            const id = Number(String(row.key).replace(/^item:/, ''));
            if (!id) continue;
            const count = Number(row.amount || 0) * (row.once ? 1 : Math.max(1, Number(node.batches || 1)));
            reserved[id] = Math.min(Number(state.inventory?.[id]?.amount || 0), (reserved[id] || 0) + count);
        }
        for (const row of node.requirements || []) visit(row.plan || network.plans?.get(row.key));
    }
    visit(plan);
    return reserved;
}

module.exports = { selectedCraftAmounts };
