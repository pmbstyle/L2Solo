'use strict';

// A conditional meeting needs its seller to travel to the advertised town.
// This is an early feasibility check, not consent: the worker and native
// transaction still verify the exact meeting point and current wallet.
const fares = new WeakMap();
function sellerCanReach(offer, seller) {
    const trade = [1, 3].includes(Number(offer?.storeType)) || ['afk_bot_store', 'afk_player_store'].includes(offer?.sourceType);
    if (!trade || seller?.phase !== 'cold' || !seller.loc || !offer.town || !Number.isFinite(Number(seller.adena))
        || !Array.isArray(seller.stats?.money) || seller.stats.money.length < 4 || seller.stats.tradeMeeting) return true;
    const town = invoke('GameServer/Bot/Economy/MarketTownPolicy').marketTown(offer.town);
    if (!town) return true;
    const origin = seller.activity === 'traveling' && seller.stats.travel?.to || seller.loc;
    const key = `${origin.locX}:${origin.locY}:${origin.locZ}:${seller.stats.karma || 0}:${offer.town}`;
    let cache = fares.get(seller);
    if (!cache) { cache = new Map(); fares.set(seller, cache); }
    if (!cache.has(key)) {
        const plan = invoke('GameServer/Bot/Population/ColdTrip').meetingTownPlan(seller, town.center);
        if (cache.size >= 32) cache.clear();
        cache.set(key, plan ? Number(plan.route.fee) : null);
    }
    const fee = cache.get(key);
    if (fee === null || !(fee > 0)) return true;
    const state = { adena: seller.adena, stats: { money: seller.stats.money } };
    return fee <= invoke('GameServer/Bot/Economy/PurchaseFunding').spendable(state, 0, { free: true });
}
module.exports = { sellerCanReach };
