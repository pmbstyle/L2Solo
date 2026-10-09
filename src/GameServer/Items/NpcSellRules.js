const BeginnerShots = require('./C4BeginnerShots');
// Use the same eligibility rule for offers and the final inventory mutation.
// A stale SellList must not make a protected item sellable.
function canSell(item) {
    return !!item
        && !BeginnerShots.isRestricted(item.fetchSelfId?.())
        && item.fetchKind?.() !== 'Other.Quest'
        && Number(item.fetchClass2?.()) !== 3
        && !item.fetchPetLocked?.()
        && !item.fetchEquipped()
        && item.fetchSelfId() !== 57;
}

// What an NPC pays for one item: half its datapack price, at least 1 adena.
// The one price for every NPC sale and every valuation at NPC liquidation.
function npcBuyPrice(basePrice) {
    return Math.max(1, Math.floor(Number(basePrice || 0) * 0.5));
}

function rows(actor) {
    return actor.backpack.fetchItems().filter(canSell).map(item => ({
        item,
        amount: item.fetchAmount(),
        price: npcBuyPrice(item.fetchPrice())
    }));
}

module.exports = { canSell, npcBuyPrice, rows };
