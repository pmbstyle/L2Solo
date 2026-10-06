const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Policy = invoke('GameServer/Bot/Economy/BuffServicePolicy');

const MAX_PURCHASES_PER_TICK = 6;

const Offer = require('./ColdBuffOffer');
const { available, skillAdapter } = Offer;

function priceOffer(provider, recipient, mpCost, count, timestamp) {
    const relation = invoke('GameServer/Social/InteractionMemoryRuntime').assess(
        { id: provider.characterId }, { id: recipient.characterId }, {}, timestamp);
    const price = Policy.priceFor({ provider, recipient, mp: mpCost, count, town: false,
        trust: Number(relation?.effective?.trust ?? relation?.personal?.trust ?? 0) });
    const wallet = Number(recipient.adena || 0);
    const benefitCeiling = Policy.incomeForTenMinutes(recipient) * 0.8;
    return price > wallet * 0.25 || price > benefitCeiling ? null : price;
}
function coldOffer(provider, recipient, timestamp = Date.now()) {
    const choice = Offer.select(provider, recipient, timestamp);
    if (!choice) return null;
    const price = priceOffer(provider, recipient, choice.mpCost, choice.selected.length, timestamp);
    return price === null ? null : { provider, recipient, spotId: provider.spotId,
        price, mpCost: choice.mpCost, effects: Offer.effectsFor(choice.selected, timestamp), timestamp };
}

async function purchase(offer) {
    const { provider, recipient, spotId, price, mpCost, effects, timestamp } = offer;
    const result = await Database.purchaseColdBuffs({
        payerId: recipient.characterId, providerId: provider.characterId, spotId,
        payerRevision: recipient.simulation?.revision || 0,
        providerRevision: provider.simulation?.revision || 0,
        price, mpCost, effects, timestamp
    });
    if (!result.ok) return result;
    const buyer = LifeState.acceptSimulationOwnership(recipient.characterId, {
        ...recipient.simulation, revision: result.buyerRevision
    }, { ...recipient, adena: result.buyerAdena, inventory: result.buyerInventory,
        stats: result.buyerStats, updatedAt: timestamp });
    const seller = LifeState.acceptSimulationOwnership(provider.characterId, {
        ...provider.simulation, revision: result.sellerRevision
    }, { ...provider, adena: result.sellerAdena, inventory: result.sellerInventory,
        vitals: { ...provider.vitals, mp: result.nextMp }, stats: result.sellerStats, updatedAt: timestamp });
    const coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    coordinator.markDirty(buyer, { critical: true, reason: 'buff_service_purchase' });
    coordinator.markDirty(seller, { critical: true, reason: 'buff_service_sale' });
    return { ok: true, price, count: effects.length, buyerId: recipient.characterId, providerId: provider.characterId };
}

// ARCH-NOTE: Retain six sales per 60 seconds globally; excess offers are
// dropped. This bounded counter replaces the timer's per-tick sales cap.
let windowAt = 0, purchased = 0;
const counters = { offers: 0, sold: 0, dropped: 0 };
async function applyOffer(packet, { beforeWrite = () => {}, timestamp = Date.now() } = {}) {
    counters.offers++;
    const drop = reason => { counters.dropped++; return { ok: false, reason }; };
    const provider = LifeState.cachedState(Number(packet?.providerId));
    const recipient = LifeState.cachedState(Number(packet?.recipientId));
    if (!provider || !recipient || provider.characterId === recipient.characterId
        || !available(provider) || !available(recipient) || provider.spotId !== packet.spotId || recipient.spotId !== packet.spotId
        || Number(provider.simulation?.revision || 0) > Number(packet.providerRevision) + 1
        || Number(recipient.simulation?.revision || 0) > Number(packet.recipientRevision) + 1) return drop('stale_offer');
    if (!Number.isSafeInteger(packet.providerRevision) || packet.providerRevision < 0
        || !Number.isSafeInteger(packet.recipientRevision) || packet.recipientRevision < 0
        || !Number.isSafeInteger(packet.mpCost) || packet.mpCost < 0 || !Number.isFinite(packet.timestamp)
        || !Array.isArray(packet.effects) || !packet.effects.length || packet.effects.length > 12
        || packet.effects.some(row => !Array.isArray(row) || row.length !== 2
            || !Number.isSafeInteger(row[0]) || row[0] <= 0 || !Number.isSafeInteger(row[1]) || row[1] <= 0)
        || Buffer.byteLength(JSON.stringify(packet), 'utf8') > Offer.MAX_OFFER_BYTES) return drop('invalid_offer');
    if (timestamp - windowAt >= 60000 || timestamp < windowAt) { windowAt = timestamp; purchased = 0; }
    if (purchased >= MAX_PURCHASES_PER_TICK) return drop('sale_limit');
    const price = priceOffer(provider, recipient, packet.mpCost, packet.effects.length, timestamp);
    if (price === null) return drop('price_limit');
    const effects = Offer.expand(packet.effects, packet.timestamp);
    try { beforeWrite(); } catch (error) { counters.dropped++; throw error; }
    // Reserve a slot before awaiting the single native transaction.
    purchased++;
    let result;
    try {
        result = await purchase({ provider, recipient, spotId: packet.spotId, price,
            mpCost: packet.mpCost, effects, timestamp: packet.timestamp });
    } catch (error) { purchased--; counters.dropped++; throw error; }
    if (!result.ok) { purchased--; return drop(result.reason || 'purchase_failed'); }
    counters.sold++;
    return result;
}
function summary() { return { ...counters }; }

module.exports = { available, coldOffer, purchase, applyOffer, summary, skillAdapter };
