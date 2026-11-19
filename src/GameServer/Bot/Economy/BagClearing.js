'use strict';

// Which bag slots a hunter destroys at its full bag, instead of walking them to town.
// C4 lets a player destroy any unequipped, destroyable item in his bag (L2J Lisvus and
// Mobius C4 clientpackets RequestDestroyItem, opcode 0x59; ours: Network/Request/TrashItem).
// When a player does it is our choice after C4 play: at a full bag he drops the slots
// that bring too little to carry and farms on. A slot pays for being carried only above
// its share of the trip's hunt time: theta = hourValue x tripHours / slots (the hunt value
// lost to the trip, per slot the trip carries). A row whose value per slot is below theta
// is cleared. The answer stands only when it frees at least the slots the spot fills in
// the trip's hours (ceil(slotsPerHour x tripHours)): a clearing then buys at least the
// hunt time the trip it replaces would cost, so it never wakes the bag more often than
// that trip would. Pure: plain rows and numbers. Callers: the economy build on both
// threads (EconomyContext, the bag's need at bag_full) and the economy model.
// rows: [{ selfId, enchant, count, slots, value, objectIds? }] (slots the row frees when
// destroyed whole, value = its nominal worth). { items, freed, value } or null.
function choose(rows, { hourValue, tripHours, slots, slotsPerHour }) {
    const hour = Number(hourValue), trip = Number(tripHours), bag = Number(slots);
    if (!(hour > 0) || !(trip > 0) || !(bag > 0)) return null;
    const theta = hour * trip / bag;
    const items = [];
    let freed = 0, value = 0;
    for (const row of rows || []) {
        const rowSlots = Number(row.slots) || 0;
        if (rowSlots <= 0 || !(Number(row.value) / rowSlots < theta)) continue;
        items.push({ selfId: Number(row.selfId), enchant: Number(row.enchant) || 0, count: Number(row.count),
            ...(row.objectIds?.length ? { objectIds: row.objectIds.map(Number) } : {}) });
        freed += rowSlots;
        value += Number(row.value) || 0;
    }
    const floor = Math.ceil(Math.max(0, Number(slotsPerHour) || 0) * trip);
    return items.length && freed >= floor ? { items, freed, value: Math.round(value) } : null;
}

module.exports = { choose };
