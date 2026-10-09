const ItemSources = require('../Items/ItemAcquisitionCatalog');
'use strict';

const { WishNetwork } = require('../Bot/Economy/WishNetwork');
const HallPolicy = require('../ClanHall/Policy');
const Rules = require('./ClanRules');
const Contributions = invoke('GameServer/Clan/ClanContributionPolicy');
const engine = new WishNetwork();
const positive = value => Math.max(0, Number(value) || 0);
const trait = (persona, name) => Math.max(0, Math.min(1, Number(persona?.traits?.[name] ?? 0.5)));

function treasury(rows = []) {
    return rows.filter(row => Number(row.selfId) === 57)
        .reduce((sum, row) => sum + Math.max(0, positive(row.amount) - positive(row.reservedAmount)), 0);
}

// Each member supplies its own visible wishes and hour, evaluated by the same
// economy as its individual purchases. Only the clan's purse pays this queue.
function build(clan, { warehouse = [], memberContexts = [], equipment = [], halls = [], proofOffer = null } = {}) {
    halls = halls.map(hall => ({ ...HallPolicy.definition(hall.id), ...hall }));
    const members = clan.members || [];
    const leaderIndex = members.findIndex(member => Number(member.characterId ?? member.id) === Number(clan.leaderId ?? clan.state?.leaderId));
    const leader = memberContexts[Math.max(0, leaderIndex)];
    const persona = leader?.persona || members[Math.max(0, leaderIndex)]?.persona || {};
    const mean = values => values.length ? values.reduce((sum, value) => sum + positive(value), 0) / values.length : 0;
    const horizons = memberContexts.map(context => positive(context.clanHorizon));
    const horizon = Math.max(1, mean(horizons));
    const memberHours = memberContexts.reduce((sum, context) => sum + positive(context.hunt?.perHour), 0);
    const duesRate = Contributions.duesRate(memberContexts.map(context => context.persona?.traits || {}));
    const income = memberHours * duesRate;
    const wallet = treasury(warehouse);
    const owned = halls.find(hall => Number(hall.ownerId) === Number(clan.id));
    const reserve = owned ? HallPolicy.reserve(owned, owned.functions || {}) : 0;
    const nodes = [];
    const level = Number(clan.level) || 0;
    const requirement = Rules.LEVEL_REQUIREMENTS[level];
    if (requirement && level <= 2) {
        const price = level <= 1 ? Contributions.scaledAdenaRequirement(level) : positive(proofOffer?.price);
        const held = requirement.itemId && warehouse.some(row => Number(row.selfId) === requirement.itemId
            && positive(row.amount) > positive(row.reservedAmount));
        if (!held) nodes.push({ key: `clan-level:${level + 1}`, need: 'status', object: { kind: 'level', level: level + 1, itemId: requirement.itemId || 0 },
            valueHours: horizon * Math.max(1, Rules.memberLimit(level + 1) - Rules.memberLimit(level)) * trait(persona, 'ambition'),
            paths: [{ kind: 'market', activity: 'clan_level', price,
                available: level <= 1 || !!proofOffer }] });
    }
    for (const entry of equipment) {
        const memberIndex = members.findIndex(member => Number(member.characterId ?? member.id) === Number(entry.memberId));
        const context = memberContexts[memberIndex];
        const id = Number(entry.plan?.target?.selfId || entry.itemId);
        if (!ItemSources.hasSource(id)) continue;
        const usefulness = positive(context?.clanItemUsefulness?.(id) ?? context?.itemUsefulness?.(id));
        if (!id || usefulness <= 0) continue;
        nodes.push({ key: `clan-item:${entry.memberId}:${id}`, need: 'care',
            object: { kind: 'equipment', itemId: id, memberId: Number(entry.memberId) }, valueHours: usefulness,
            paths: [{ kind: entry.plan?.strategy || 'market', activity: 'clan_equipment',
                price: Math.max(0, positive(entry.plan?.bridgeCost ?? entry.plan?.market?.price)
                    - positive(invoke('GameServer/Bot/Economy/PurchaseFunding').spendable(members[memberIndex] || {}, 0, { free: true }))),
                costHours: positive(entry.costHours), available: entry.plan?.status !== 'blocked' }] });
    }
    if (owned) {
        const wanted = HallPolicy.desired(owned, members);
        const installed = owned.functions || {};
        const next = Object.entries(wanted).find(([kind, amount]) => positive(installed[kind]) < amount);
        if (next) {
            const activation = Math.max(0, HallPolicy.fee(owned, ...next) - (HallPolicy.fee(owned, next[0], positive(installed[next[0]])) || 0));
            const price = HallPolicy.reserve(owned, { ...installed, [next[0]]: next[1] }) - reserve + activation;
            nodes.push({ key: `clan-hall-upgrade:${owned.id}:${next[0]}:${next[1]}`, need: 'care',
                object: { kind: 'hall_upgrade', hallId: Number(owned.id), function: next[0], level: next[1] },
                valueHours: horizon * members.length * (next[1] - positive(installed[next[0]])) / 100,
                paths: [{ kind: 'hall_upgrade', activity: 'clan_hall', price }] });
        }
    }
    const hallValues = new Map();
    if (!owned && level >= 2) for (const hall of halls) {
        if (Number(hall.ownerId)) continue;
        const upgrades = HallPolicy.desired(hall, members);
        // Recovery shortens the members' existing rest, while a residence is
        // public status for the leader. Rent is a cost, not extra usefulness.
        const recovery = memberContexts.reduce((sum, context, index) => {
            const rest = Math.max(0, Math.min(1, Number(context.hunt?.restFraction || 0)));
            const recoveryGain = Math.max(positive(upgrades.hp) / (100 + positive(upgrades.hp)),
                positive(upgrades.mp) / (100 + positive(upgrades.mp)));
            const local = String(members[index]?.currentRegion || '').toLowerCase() === String(hall.town).toLowerCase();
            return sum + (horizons[index] || 0) * rest * recoveryGain * (local ? 1 : 0);
        }, 0);
        const value = recovery + horizon * members.length * trait(persona, 'ambition') * positive(hall.grade) / 3;
        const maintenance = HallPolicy.reserve(hall, upgrades);
        hallValues.set(Number(hall.id), { valueHours: value, maintenance });
        nodes.push({ key: `clan-hall:${hall.id}`, need: 'status', object: { kind: 'hall', hallId: Number(hall.id) },
            valueHours: value, paths: [{ kind: 'auction', activity: 'clan_hall', price: positive(hall.minimumBid) + maintenance }] });
    }
    // One hall alternative enters the purse; competing lots are not separate
    // promises to buy several residences. The native bid still checks funds.
    const hallNodes = nodes.filter(node => node.object.kind === 'hall').sort((a, b) => b.valueHours / Math.max(1, b.paths[0].price)
        - a.valueHours / Math.max(1, a.paths[0].price) || a.object.hallId - b.object.hallId);
    const chosenHall = hallNodes[0];
    const selected = nodes.filter(node => node.object.kind !== 'hall').sort((a, b) => b.valueHours / Math.max(1, b.paths[0].price)
        - a.valueHours / Math.max(1, a.paths[0].price) || a.key.localeCompare(b.key)).slice(0, chosenHall ? 11 : 12);
    if (chosenHall) selected.push(chosenHall);
    const inputKey = JSON.stringify([wallet, reserve, level, persona, selected,
        memberContexts.map(context => context.inputKey), clan.state?.goal?.economy?.focus]);
    const network = engine.build({ actorKey: `clan:${clan.id}`, inputKey, nodes: selected, roots: selected.map(node => node.key),
        wallet, survivalReserve: reserve, persona, hourAdena: income,
        playedHours: mean(members.map(member => member.stats?.playedHours)),
        previous: clan.state?.goal?.economy || { focus: clan.state?.wishFocus, dormant: clan.state?.dormantWishes },
        moneyPaths: income > 0 ? [{ kind: 'dues', activity: 'clan_dues', incomePerHour: income }] : [] });
    function budgetFor(kind, id, memberId) {
        let left = Math.max(0, wallet - reserve);
        for (const wish of network.queue) {
            if (wish.object.kind === kind && (id === undefined || Number(wish.object.itemId ?? wish.object.hallId) === Number(id))
                && (memberId === undefined || Number(wish.object.memberId) === Number(memberId))) return left;
            if (!wish.funded) return 0;
            left -= wish.price;
        }
        return 0;
    }
    function hallBid(hall) {
        const key = `clan-hall:${hall.id}`;
        const wish = network.queue.find(row => row.key === key);
        const value = hallValues.get(Number(hall.id));
        if (!wish || !value) return 0;
        const purse = Math.max(0, budgetFor('hall', hall.id) - value.maintenance);
        const worth = network.moneyPrice > 0 ? wish.valueHours / network.moneyPrice : purse;
        return Math.max(0, Math.floor(Math.min(purse, worth)));
    }
    return { actorKey: `clan:${clan.id}`, inputKey, wallet, reserve, incomePerHour: income, network,
        focusObject: selected.find(node => node.key === network.focus?.[0])?.object || null,
        moneyPrice: network.moneyPrice, hourAdena: network.hourAdena, persona, budgetFor, hallBid,
        hall: chosenHall ? halls.find(hall => Number(hall.id) === chosenHall.object.hallId) : null,
        statsPacket: { wishFocus: network.focus, dormantWishes: network.dormant } };
}

function forClan(clan, inputs = {}) {
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation');
    const Decisions = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions;
    const memberContexts = (clan.members || []).map(member => {
        const numbers = Decisions.clanNumbers(member.characterId ?? member.id);
        // ARCH-NOTE: a complete cold decision already supplies the member's
        // hour and horizon. Compute its network-free fallback only on demand,
        // at most once in this clan review; retain no additional member cache.
        let fallback;
        const basics = () => fallback ??= Economy.basics(member, { persona: member.persona, timestamp: inputs.timestamp });
        const clanHorizon = numbers?.horizonHours ?? Valuation.stageHours(member, basics().hunt.expPerHour, basics().persona);
        const clanItemUsefulness = id => {
            if (!ItemSources.hasSource(id)) return 0;
            if (Number(id) === Number(numbers?.plan?.itemId)) return positive(numbers.plan.valueHours);
            const item = require('../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, id);
            if (!item?.etc?.slot) return 0;
            const gain = require('../Bot/Economy/WishProviders').gearGain(member, item, basics().timestamp);
            return Math.max(0, (gain.attack + gain.defence * basics().deathHours) * clanHorizon);
        };
        return { persona: member.persona || basics().persona, clanHorizon,
            hunt: { perHour: numbers?.huntPerHour ?? basics().hunt.perHour },
            // ARCH-NOTE: Address the member decision, without retaining its
            // multi-KB network key. The clan's unchanged event-key lottery
            // gets a new seed; values and funding stay identical.
            inputKey: `${member.characterId ?? member.id}:${numbers?.updatedAt ?? member.updatedAt ?? 0}`,
            clanItemUsefulness };
    });
    const equipment = inputs.equipment || (clan.members || []).flatMap(member => member.stats?.equipmentPlan
        ? [{ memberId: member.characterId ?? member.id, plan: member.stats.equipmentPlan }] : []);
    const proofOffer = Object.hasOwn(inputs, 'proofOffer') ? inputs.proofOffer : Number(clan.level) === 2
        ? invoke('GameServer/Bot/Economy/MarketOpportunity').bestOffer(Rules.LEVEL_REQUIREMENTS[2].itemId, { budget: Infinity }) : null;
    return build(clan, { ...inputs, proofOffer, equipment, memberContexts });
}
module.exports = { build, forClan, treasury, reset: () => engine.clear() };
