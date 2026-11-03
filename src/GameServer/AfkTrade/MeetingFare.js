'use strict';

// A conditional meeting needs its seller to travel to the advertised town.
// This is an early feasibility check, not consent: the worker and native
// transaction still verify the exact meeting point and current wallet.
const fares = new WeakMap();
function sellerCanReach(offer, seller) {
    const trade = [1, 3].includes(Number(offer?.storeType)) || ['afk_bot_store', 'afk_player_store'].includes(offer?.sourceType);
    if (!trade || seller?.phase !== 'cold' || !seller.loc || !offer.town || !Number.isFinite(Number(seller.adena))
        || !Array.isArray(seller.stats?.money) || seller.stats.money.length < 4 || seller.stats.tradeMeeting) return true;
    const origin = seller.activity === 'traveling' && seller.stats.travel?.to || seller.loc;
    // Read per offer of a board scan: one row per seller state, its origin and wallet.
    const karma = seller.stats.karma || 0;
    let cache = fares.get(seller);
    if (cache?.x !== origin.locX || cache.y !== origin.locY || cache.z !== origin.locZ || cache.karma !== karma) {
        cache = { x: origin.locX, y: origin.locY, z: origin.locZ, karma, towns: new Map() };
        fares.set(seller, cache);
    }
    let fee = cache.towns.get(offer.town);
    if (fee === undefined) {
        const town = invoke('GameServer/Bot/Economy/MarketTownPolicy').marketTown(offer.town);
        const plan = town ? invoke('GameServer/Bot/Population/ColdTrip').meetingTownPlan(seller, town.center) : null;
        fee = plan ? Number(plan.route.fee) : null;
        cache.towns.set(offer.town, fee);
    }
    if (fee === null || !(fee > 0)) return true;
    if (cache.adena !== seller.adena || cache.money !== seller.stats.money) {
        cache.adena = seller.adena; cache.money = seller.stats.money;
        // lazy: optional PartyAdmission loads this with no game globals.
        cache.free = invoke('GameServer/Bot/Economy/PurchaseFunding').spendable({ adena: seller.adena, stats: { money: seller.stats.money } }, 0, { free: true });
    }
    return fee <= cache.free;
}
module.exports = { sellerCanReach };
