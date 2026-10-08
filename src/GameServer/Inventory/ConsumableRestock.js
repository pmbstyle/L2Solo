// A consumable bought from the NPC on a restock, one form for every stock
// (healing potions, Scrolls of Escape): a line { selfId, name, currentAmount,
// amount, unitPrice, cost, adena } is written into a cold state (inventory
// summary and Adena) or into a hot actor's backpack (item row and Adena row).
// ARCH-NOTE: The shared cold patch has no SQL dependency. Resolve Database
// only for the existing paid actor write, retaining its refusal ordering.
let database;
const persistenceDatabase = () => database ||= invoke('Database');

function coldPatch(state, line) {
    const inventory = { ...(state.inventory || {}) };
    const key = String(line.selfId);
    inventory[key] = {
        ...(inventory[key] || {}),
        selfId: line.selfId,
        name: line.name,
        amount: line.currentAmount + line.amount
    };
    inventory['57'] = {
        ...(inventory['57'] || {}),
        selfId: 57,
        name: 'Adena',
        amount: line.adena - line.cost
    };
    return {
        adena: line.adena - line.cost,
        inventory,
        purchase: {
            selfId: line.selfId,
            name: line.name,
            amount: line.amount,
            unitPrice: line.unitPrice,
            cost: line.cost,
            at: Date.now()
        }
    };
}

function ensureActorStock(actor, line) {
    const current = actor.backpack.fetchItemFromSelfId(line.selfId);
    const nextAmount = line.currentAmount + line.amount;
    if (current) {
        return persistenceDatabase().updateItemAmount(actor.fetchId(), current.fetchId(), nextAmount).then(() => {
            current.setAmount(nextAmount);
            return nextAmount;
        });
    }
    return persistenceDatabase().setItem(actor.fetchId(), {
        selfId: line.selfId,
        name: line.name,
        amount: nextAmount,
        equipped: false,
        slot: 0
    }).then((packet) => {
        actor.backpack.insertItem(Number(packet.insertId), line.selfId, { amount: nextAmount });
        return nextAmount;
    });
}

// Pays the line's cost from the Adena row, then adds the items. Resolves
// { ok, nextAdena, nextAmount } or { ok: false, reason: 'missing_adena' }.
function buyForActor(actor, line) {
    const adenaItem = actor.backpack.fetchItemFromSelfId(57);
    if (!adenaItem) return Promise.resolve({ ok: false, reason: 'missing_adena' });
    if (actor.session?.actor === actor
        && Number(actor.session.coldLifeState?.characterId) === Number(actor.fetchId())) {
        const town = actor.session.shoppingTarget?.town
            || invoke('GameServer/Bot/AI/TownTransitPolicy').townAt(actor)
            || actor.session.coldLifeState.currentRegion;
        return invoke('GameServer/Bot/Economy/NpcRestockPlan').purchaseForActor(actor, { town,
            shots: false, potions: false, scrolls: false,
            extras: [{ selfId: line.selfId, amount: line.amount, unitPrice: line.unitPrice }] }).then(result => ({
            ok: result.ok && result.units > 0, reason: result.units ? undefined : 'not_enough_adena',
            nextAdena: Number(actor.backpack.fetchItemFromSelfId(57)?.fetchAmount?.() || 0),
            nextAmount: Number(actor.backpack.fetchItemFromSelfId(line.selfId)?.fetchAmount?.() || 0) }));
    }
    const nextAdena = line.adena - line.cost;
    return persistenceDatabase().updateItemAmount(actor.fetchId(), adenaItem.fetchId(), nextAdena)
        .then(() => {
            adenaItem.setAmount(nextAdena);
            return ensureActorStock(actor, line);
        })
        .then((nextAmount) => ({ ok: true, nextAdena, nextAmount }));
}

module.exports = { coldPatch, buyForActor };
