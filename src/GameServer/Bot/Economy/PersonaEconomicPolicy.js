const BotPersona = invoke('GameServer/Bot/AI/BotPersona');

const EARLY_SALE_ITEM_COUNT = 2;
const EARLY_SALE_VALUE = 600;
const WEALTH_SALE_PRIORITY_BONUS = 12;

function personaFor(state = {}) {
    return state?.persona?.traits ? state.persona : BotPersona.generate(state);
}

function wealthSaleOpportunity(state = {}, sale = {}) {
    const persona = personaFor(state);
    if (persona?.primaryDrive !== 'wealth') return null;

    const focus = (sale.items || []).reduce((best, item) => {
        const value = Number(item?.count || 0) * Number(item?.price || 0);
        const bestValue = Number(best?.count || 0) * Number(best?.price || 0);
        return value > bestValue || (value === bestValue && Number(item?.selfId || 0) < Number(best?.selfId || 0))
            ? item
            : best;
    }, null);
    if (!focus) return null;
    const focusValue = Number(focus.count || 0) * Number(focus.price || 0);
    const qualifying = Number(sale.itemCount || 0) >= EARLY_SALE_ITEM_COUNT
        && Number(sale.marketValue || 0) >= EARLY_SALE_VALUE;
    if (!qualifying) return null;

    return {
        priorityBonus: WEALTH_SALE_PRIORITY_BONUS,
        reason: 'liquidate_best_surplus',
        focus: {
            itemId: Number(focus.selfId || 0),
            itemName: focus.name || `Item ${focus.selfId}`,
            count: Number(focus.count || 0),
            unitPrice: Number(focus.price || 0),
            value: focusValue
        },
        persona
    };
}

module.exports = {
    EARLY_SALE_ITEM_COUNT,
    EARLY_SALE_VALUE,
    WEALTH_SALE_PRIORITY_BONUS,
    wealthSaleOpportunity
};
