'use strict';
function significant(value) { return Number.isFinite(value) ? Number(value.toPrecision(3)) : value; }
function compact(stats = {}) {
    const next = { ...stats };
    if (next.equipmentPlan) {
        next.equipmentPlan = { ...next.equipmentPlan };
        delete next.equipmentPlan.economyInputKey; delete next.equipmentPlan.inputKey;
    }
    delete next.marketTrades; delete next.priceBeliefs;
    // ARCH-NOTE: existing worlds retain old operation lists (91 withdrawals,
    // 57 NPC sales in the saved-current fixture). Bound them on an ordinary
    // save too, so bots need no new withdrawal/liquidation or startup pass.
    const Operations = require('./LastOperations');
    if (next.lastWarehouseWithdrawal) next.lastWarehouseWithdrawal = Operations.normalize(next.lastWarehouseWithdrawal);
    if (next.lastNpcLiquidation) next.lastNpcLiquidation = Operations.normalize(next.lastNpcLiquidation, { field: 'sold' });
    if (Array.isArray(next.huntEfficiency)) next.huntEfficiency = next.huntEfficiency.map(row => {
        const rounded = { ...row };
        for (const key of ['exp', 'kills']) if (typeof rounded[key] === 'number') rounded[key] = significant(rounded[key]);
        for (const key of ['adena', 'loot']) if (Number.isFinite(rounded[key])) rounded[key] = Math.round(rounded[key]);
        // Played hours, timestamps and cycle duration retain their exact values.
        return rounded;
    });
    return next;
}
module.exports = { compact };
