'use strict';
const assert = require('node:assert/strict');
const stock = require('./profitable_stock_state');

function prepareRoutes(state) {
    const steps = invoke('GameServer/Bot/Economy/EconomicTrip').prepare(state);
    let next;
    do { next = steps.next(); } while (!next.done);
    return next.value;
}

function review(state, { timestamp, spots, lookup, buyOrderEscrow = 0 }) {
    return invoke('GameServer/Bot/Economy/EconomyContext').forState(state, {
        timestamp, spots, routeRows: prepareRoutes(state), buyOrderEscrow,
        npcOffersFor: id => lookup.offersFor(id)
    });
}

function describe(economy) {
    const activity = economy.network.activity;
    const gear = economy.network.queue.find(wish => wish.key === activity?.rootKey);
    return JSON.stringify({ activity, chosen: gear && {
        key: gear.key, funded: gear.funded, object: gear.object, price: gear.price
    }, money: economy.statsPacket.money,
    queue: economy.network.queue.slice(0, 6).map(wish =>
        [wish.key, wish.object?.itemId, wish.object?.slot, wish.funded, wish.price]) });
}

// T43 table: '7_20' now has potion demand, and this gear-only NPC lookup sells no potions,
// so its unsupported survival stock outranks the gear wish; '-11_29' (the level-30 pick) has none.
module.exports = function nativeGearEconomy({ characterId, timestamp = Date.now(),
    loc = { locX: 81100, locY: 148000, locZ: -3466 }, currentRegion = 'Giran',
    spotId = '-11_29', spots = [stock.spotFor(spotId)] } = {}) {
    const lookup = invoke('GameServer/Bot/Population/ColdNpcPlanningCatalog').createLookup(
        invoke('GameServer/Bot/Population/ColdSimulationCoordinator').npcPlanningCatalogRows());
    const kit = stock.kitFor(0, 30);
    const member = { characterId, level: 30, phase: 'cold', activity: 'hunting',
        exp: invoke('GameServer/DataCache').experience[29], adena: 1000000,
        currentRegion, spotId, loc: { ...loc }, stats: { classId: 0, role: 'dps' },
        inventory: { ...kit.inventory, 57: { selfId: 57, name: 'Adena', amount: 1000000, stackable: true } } };
    assert.strictEqual(invoke('GameServer/Bot/AI/PersonalGearProgression').assess(member).required, false);
    const missing = kit.entries.find(entry => [6, 9, 12].includes(entry.slot)
        && member.inventory[entry.selfId].amount === 1
        && lookup.offersFor(entry.selfId).length > 0);
    assert(missing, 'the native D kit has a single-slot wearable sold by canonical NPCs');
    delete member.inventory[missing.selfId];
    const economy = review(member, { timestamp, spots, lookup });
    const activity = economy.network.activity;
    const gear = economy.network.queue.find(wish => wish.key === activity?.rootKey);
    const selected = activity?.activity === 'shopping' && !activity.funding && gear?.object?.slot && gear.funded;
    if (!selected) {
        const admission = economy.projection?.admission, slot = Number(missing.slot);
        console.error('Native gear admission:', JSON.stringify({ missing: [missing.selfId, slot],
            horizon: economy.projection?.horizon,
            hunt: economy.hunt ? { id: economy.hunt.spotId, net: economy.hunt.netIncomePerHour } : null,
            admission: admission ? { candidates: admission.candidates, evaluations: admission.evaluations,
                maxScratch: admission.maxScratch, rounds: admission.rounds,
                pending: (admission.pending || []).filter(row => String(row.key).startsWith('power:')
                    && Number(String(row.key).split(':').at(-1)) === slot).slice(0, 8),
                admitted: (admission.admitted || []).filter(row => Number(row.family) === slot).slice(0, 4) } : null,
            offers: lookup.offersFor(missing.selfId).map(offer => ({ town: offer.town, price: offer.price,
                route: economy.trip.details(offer.town) })) }));
    }
    assert(selected,
        `native selected gear prerequisite: ${describe(economy)}`);
    assert(Array.isArray(economy.statsPacket.money), `native money packet: ${describe(economy)}`);
    const plan = invoke('GameServer/Bot/AI/GearPlanSelection').selectAcquisitionPlan(member, null, {
        spots, timestamp, planningOptions: lookup.plannerOptions, preparedEconomy: economy
    }).acquisitionPlan;
    assert(plan?.status === 'active' && plan.strategy === 'market' && plan.market?.sourceType === 'npc'
        && plan.market.price > 0 && plan.target?.selfId === gear.object.itemId,
    `native NPC gear selection: ${JSON.stringify(plan)}; ${describe(economy)}`);
    return { member, economy, spots, plan, planningOptions: lookup.plannerOptions,
        review: (state, options = {}) => review(state, { timestamp, spots, lookup, ...options }) };
};
module.exports.prepareRoutes = prepareRoutes;
module.exports.describe = describe;
