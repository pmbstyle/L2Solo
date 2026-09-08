// Use the same eligibility rule for offers and the final inventory mutation.
// A stale SellList must not make a protected item sellable.
function canSell(item) {
    return !!item
        && item.fetchKind?.() !== 'Other.Quest'
        && Number(item.fetchClass2?.()) !== 3
        && !item.fetchPetLocked?.()
        && !item.fetchEquipped()
        && item.fetchSelfId() !== 57;
}

function rows(actor) {
    return actor.backpack.fetchItems().filter(canSell).map(item => ({
        item,
        amount: item.fetchAmount(),
        price: Math.max(1, Math.floor(item.fetchPrice() * 0.5))
    }));
}

module.exports = { canSell, rows };
