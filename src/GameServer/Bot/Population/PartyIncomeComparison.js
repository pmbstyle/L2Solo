'use strict';

const BuffPolicy = invoke('GameServer/Bot/Economy/BuffServicePolicy');
const Rewards = require('../Economy/SpotRewardExpectation');
const GameDataCatalogue = require('../../Knowledge/GameDataCatalogue');
const Material = require('./CraftMaterialParty');
const SpotEconomics = require('../Economy/SpotEconomics');
const HOUR_MS = 3600000;
const REVIEW_MS = 5 * 60000;
const MAX_SOLO_CHECKS = 12;
const soloChoices = new WeakMap();
// Party formation hydrates fresh row copies every call, so the per-object hold
// above never spans calls; this one holds the same choice for an unchanged row.
const soloHolds = new Map();
const SOLO_HOLD_LIMIT = 4096;
const soloHoldCounts = { hits: 0, misses: 0 };
const positive = value => Math.max(0, Number(value) || 0);
const rosterKey = members => members.map(member => Number(member.characterId)).sort((a, b) => a - b).join(',');
const adventurer = state => invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(state);
const soloState = state => ({ ...state, activity: 'hunting', partyId: null,
    party: { ...state.party, partyId: null }, stats: { ...state.stats, backgroundPartyId: null, routeMode: 'solo' } });

// Pure comparison in the same units as fundingDelay. No XP reward enters
// admission. Random/turn loot uses the member's expectation, never group cash.
function evaluate({ solo, party, cash = null, spendable = 0, fee = 0, rewardFee = 0,
    soloItemHours = null, partyItemHours = null, deliveryHours = partyItemHours, assemblyHours = 0 } = {}) {
    const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation');
    const ready = (route, cashNow, direct) => {
        const funding = cash === null ? null : Valuation.fundingDelay({
            requiredCash: cash, spendableCash: cashNow, incomePerHour: route?.income || 0 });
        const choices = [funding === null ? null : funding + (funding > 0 ? positive(route?.travelHours) : 0), direct]
            .filter(hours => hours !== null && Number.isFinite(hours) && hours >= 0);
        return choices.length ? Math.min(...choices) : null;
    };
    const soloHours = ready(solo, Math.max(0, spendable - positive(solo?.buffPrice)), soloItemHours);
    let partyHours = ready(party, Math.max(0, spendable - positive(fee)), partyItemHours);
    if (party?.income > 0 && cash !== null && deliveryHours !== null && Number.isFinite(deliveryHours)
        && rewardFee > 0) {
        const afterFee = Valuation.fundingDelay({ requiredCash: cash,
            spendableCash: spendable + rewardFee, incomePerHour: party.income });
        const paidReady = Math.max(deliveryHours, afterFee) + positive(party.travelHours);
        partyHours = partyHours === null ? paidReady : Math.min(partyHours, paidReady);
    }
    const groupHours = partyHours === null ? null : partyHours + positive(assemblyHours);
    // A promised helper payment is received after delivery, not liquid cash
    // for an immediate purchase. Amortize it only over a known delivery time.
    const partyIncome = party ? Number(party.income) + (deliveryHours > 0
        ? positive(rewardFee) / (deliveryHours + positive(assemblyHours)) : 0) : null;
    let reason = 'solo_preferred', accept = false;
    if (positive(fee) > positive(spendable)) reason = 'help_fee_unfunded';
    else if (cash === null && soloItemHours === null && partyItemHours === null && party
        && partyIncome > positive(solo?.income) * 1.1) {
        accept = true; reason = 'higher_personal_income';
    } else if (!party || groupHours === null && soloHours === null) reason = 'income_unknown';
    else if (partyIncome > 0 && soloHours === null && groupHours !== null) {
        accept = true; reason = 'goal_requires_party';
    } else if (partyIncome > 0 && soloHours !== null && groupHours !== null
        && groupHours < soloHours * 0.9) {
        accept = true; reason = 'equipment_sooner';
    }
    return { accept, reason, soloIncome: solo ? Number(solo.income) : null,
        partyIncome, soloHours, partyHours: groupHours, fee: positive(fee),
        soloSpotId: solo?.spotId || null, soloBuffPrice: positive(solo?.buffPrice) };
}

function soloRoute(state, spots, timestamp, peers = []) {
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Route = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
    const standalone = soloState(state);
    let held = soloChoices.get(state);
    if (!held || held.spots !== spots || timestamp < held.at || timestamp - held.at >= REVIEW_MS) {
        const input = rowInput(state);
        const byId = input && soloHolds.get(Number(state.characterId));
        if (byId && byId.input === input && byId.spots === spots && timestamp >= byId.at && timestamp - byId.at < REVIEW_MS) {
            held = { spots, at: byId.at, choice: byId.choice };
            soloHoldCounts.hits += 1;
        } else {
            // The spot the bot holds for earning (decision 10-30) first; a full search when it fails.
            const options = { spots, timestamp, required: true, mode: 'solo', maxChecks: MAX_SOLO_CHECKS };
            const heldSpot = invoke('GameServer/Bot/Economy/EconomyContext').heldIncomeSpot(state.characterId, timestamp); // lazy: cycle EconomyContext > PartyIncomeComparison
            held = { spots, at: timestamp, choice: (heldSpot != null && Route.select(standalone, { ...options, only: [heldSpot] }))
                || Route.select(standalone, options) };
            if (input) soloHoldCounts.misses += 1;
            if (input) holdById(Number(state.characterId), { input, spots, at: timestamp, choice: held.choice }, timestamp);
        }
        soloChoices.set(state, held);
    }
    const choice = held.choice;
    if (!choice) return null;
    const row = choice.row;
    let best = { ...row, income: row.income * Hunt.onSpotShare(state), spotId: choice.spot.id,
        travelHours: walkHours(state, choice.spot), source: 'solo_route', buffPrice: 0 };
    // At most one physically available provider: compare buying its native
    // useful effects at the existing price with the unbuffed earning route.
    const Offer = invoke('GameServer/Bot/Economy/ColdBuffOffer');
    const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
    for (const provider of peers.slice(0, 9)) {
        if (!Offer.available(provider) || provider.spotId !== choice.spot.id || standalone.spotId !== choice.spot.id) continue;
        const buff = Offer.select(provider, standalone, timestamp);
        if (!buff) continue;
        const price = BuffPolicy.priceFor({ provider, recipient: standalone, mp: buff.mpCost, count: buff.selected.length, town: false });
        if (price > positive(state.adena) * 0.25 || price > BuffPolicy.incomeForTenMinutes(standalone) * 0.8) continue;
        const effects = Offer.effectsFor(buff.selected, timestamp);
        const duration = Math.min(...effects.map(effect => effect.durationMs)) / HOUR_MS;
        const boosted = withEffects(standalone, effects);
        const profiles = Match.stateProfiles(boosted, { timestamp, buffed: true });
        if (!Match.spotMatchup(choice.spot, profiles, { soloSafety: true }).eligible) continue;
        const baseDamage = Match.damageRate(Match.stateProfiles(standalone, { timestamp, buffed: true }));
        const gain = baseDamage > 0 ? Match.damageRate(profiles) / baseDamage : 1;
        const income = (row.income * Math.min(gain, 300 / Math.max(1, row.kills)) - price / duration) * Hunt.onSpotShare(state);
        if (income > best.income) best = { ...best, income, buffPrice: price, source: 'paid_buff' };
        break;
    }
    return best;
}

// Cold rows only: every write to a far row moves its revision.
function rowInput(state) {
    if (state.phase !== 'cold' || !(Number(state.simulation?.revision) > 0) || !(Number(state.characterId) > 0)) return null;
    return Number(state.simulation.revision);
}
let soloHoldSpots = null;
function holdById(characterId, entry, timestamp) {
    // A rebuilt spot table (SpotProfiles.reset) voids every hold; keep no old table reachable from here.
    if (entry.spots !== soloHoldSpots) { soloHolds.clear(); soloHoldSpots = entry.spots; }
    // Delete before set: the Map order follows `at`, so the oldest entry is the front.
    soloHolds.delete(characterId);
    soloHolds.set(characterId, entry);
    for (const [id, held] of soloHolds) {
        if (soloHolds.size <= SOLO_HOLD_LIMIT && timestamp - held.at < REVIEW_MS) break;
        soloHolds.delete(id);
    }
}
const soloHoldStats = () => ({ ...soloHoldCounts, size: soloHolds.size });

function withEffects(state, effects) {
    const Loadout = invoke('GameServer/Bot/AI/PartyBuffLoadout');
    const families = new Set(effects.map(effect => Loadout.family(effect.key)));
    return { ...state, stats: { ...state.stats, coldCombat: { ...state.stats?.coldCombat,
        effects: [...(state.stats?.coldCombat?.effects || []).filter(effect => !families.has(Loadout.family(effect.key))), ...effects] } } };
}
function walkHours(state, spot) {
    const origin = state.loc, destination = spot?.center;
    return origin && destination ? Math.hypot(Number(origin.locX || 0) - Number(destination.locX || 0),
        Number(origin.locY || 0) - Number(destination.locY || 0)) / (120 * 3600) : 0;
}

// One bounded forecast for a complete roster. Static point lookups are
// cached by role/level/rates in SpotValueTable. No wish graph or combat roll.
function prepare(members, { objective, party, spots, memberContexts, timestamp = Date.now() } = {}) {
    spots ||= invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    const spotId = objective?.spotId || party?.spotId || members[0]?.spotId;
    const spot = invoke('GameServer/Bot/AI/SpotIndex').spotById(spots, spotId);
    if (!spot || spot.raidBoss || !members.length || members.length > 9) return { rows: new Map(), spots, timestamp, spot };
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
    const key = rosterKey(members);
    const spoilerIndex = members.findIndex(member => invoke('GameServer/Bot/AI/BotRoles').isSpoiler(member));
    const level = Math.max(...members.map(member => positive(member.level)));
    const Offer = invoke('GameServer/Bot/Economy/ColdBuffOffer');
    // The seller's solo copy is the same for every recipient: built once per roster.
    const providers = members.filter(member => BuffPolicy.serviceClass(member))
        .slice(0, 1).map(soloState);
    const buffed = members.map(member => {
        const recipient = soloState(member);
        for (const provider of providers) {
            const choice = Offer.select(provider, recipient, timestamp);
            if (choice) return withEffects(member, Offer.effectsFor(choice.selected, timestamp));
        }
        return member;
    });
    const values = members.map((member, index) => {
        const row = Table.value(spot.id, Table.roleFor(member), member.level, true,
            { spoilSkillLevel: Rewards.spoilSkillLevel(member) });
        if (!row || buffed[index] === member) return row;
        const damage = Match.damageRate(Match.stateProfiles(member, { timestamp, buffed: true }));
        const gain = damage > 0 ? Match.damageRate(Match.stateProfiles(buffed[index], { timestamp, buffed: true })) / damage : 1;
        // Native buff stats change damage throughput, never drop rates or the
        // member's ownership share. Recovery gains wait for real samples.
        return { ...row, kills: row.kills * Math.max(1, gain) };
    });
    const gross = Table.value(spot.id, 'dps', level, true) || Table.value(spot.id, 'mage', level, true);
    const safe = Match.spotMatchup(spot, Match.stateProfiles(buffed[0],
        { timestamp, capacityStates: buffed, mode: 'party', buffed: true }), { soloSafety: true }).eligible;
    const totalKills = values.reduce((sum, row) => sum + positive(row?.kills), 0);
    // The cold resolver opens at most one encounter per 12 seconds, shared
    // by all members. A large group cannot multiply that supply of monsters.
    const kills = Math.min(300, totalKills) * Math.min(1, positive(party?.cohesion || 0.65));
    const rows = new Map();
    for (let index = 0; index < members.length; index++) {
        const member = members[index], row = values[index];
        const observed = Hunt.sampledRows(member, timestamp, 'party')
            .filter(sample => sample.spotId === spot.id && sample.partyRoster === key);
        const actual = Hunt.bestIncome(observed, Hunt.onSpotShare(member));
        if (actual) { rows.set(member.characterId, { income: actual.perHour, kills: observed[0].kills / observed[0].cycleMs * HOUR_MS,
            spotId, source: 'own_party', travelHours: 0 }); continue; }
        if (!safe || !gross?.kills || !row?.kills || !kills) continue;
        const costs = Hunt.consumablePrices(member);
        const share = row.kills / totalKills;
        const expected = Rewards.value(spot, level, { spoilSkillLevel: index === spoilerIndex ? Rewards.spoilSkillLevel(member) : 0,
            spoilerLevel: member.level });
        const drop = expected ? expected.drop : (gross.dropLoot ?? gross.loot) / gross.kills;
        // Spoil stays with its spoiler under the native party agreement.
        const raw = Table.value(spot.id, Table.roleFor(member), member.level, true,
            { spoilSkillLevel: Rewards.spoilSkillLevel(member) });
        const spoil = expected?.spoil || 0;
        const income = kills * ((expected?.adena ?? gross.adena / gross.kills) / members.length + drop / members.length + spoil
            - share * (raw.shots * costs.shots + raw.potions * costs.potions) / raw.kills);
        rows.set(member.characterId, { income: income * Hunt.onSpotShare(member), kills, spotId,
            source: 'table_party', travelHours: walkHours(member, spot) });
    }
    return { rows, spots, timestamp, spot, roster: key,
        workshops: new Map((memberContexts || []).map(context => [context.state.characterId, context.workshop])) };
}

function itemHours(state, spot, kills, goal, members, agreement) {
    const npcId = Number(goal?.npcId), itemId = Number(goal?.itemId);
    if (!spot || !npcId || !itemId || !(kills > 0)) return null;
    const Catalogue = GameDataCatalogue.native();
    const reward = Catalogue.rewardForNpc(npcId), npc = Catalogue.npc(npcId);
    if (!reward || !npc) return null;
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const next = state.stats?.equipmentPlan?.next;
    const spoil = goal.sourceKind === 'spoil' || goal.strategy === 'spoil' || Number(next?.itemId) === itemId && next.kind === 'spoil';
    const owners = agreement?.materialNeeds ? Material.needs(members, { spotId: spot.id }, agreement)
        .filter(row => Number(row.itemId) === itemId) : [];
    const ownNeed = owners.find(row => row.characterId === Number(state.characterId));
    // A material contract forwards the helper's actual spoil to its owner.
    // Ordinary/solo loot still requires the recipient to be the spoiler.
    if (spoil && !invoke('GameServer/Bot/AI/BotRoles').isSpoiler(state)
        && !(agreement?.spoil === 'need' && ownNeed?.sourceKind === 'spoil'
            && Number(ownNeed.npcId) === npcId && Material.partySpoiler(members))) return null;
    const killerLevel = Math.max(...members.map(member => Number(member.level)));
    const expected = Planner.itemDropYield(reward, itemId, spoil ? 'spoil' : 'drop',
        { npcLevel: Number(npc.template?.level || spot.avgLevel), killerLevel }).expectedYield;
    const { count, totalCount: total } = Catalogue.spotNpcWeights(spot, npcId);
    // Only a funded escrow promises a personal item. Before funding, even
    // required requests and a proposed 'need' agreement get the random share.
    const reserved = agreement?.help?.status === 'funded' && Number(agreement.help.payerId) === Number(state.characterId)
        && Number(agreement.help.itemId) === itemId;
    // Forecast completing the shared need, with no helper loot dilution.
    const totalNeed = owners.reduce((sum, row) => sum + row.amount, 0);
    const ownerShare = ownNeed && totalNeed > 0 ? ownNeed.amount / totalNeed : spoil || reserved ? 1 : 1 / members.length;
    const perHour = kills * expected * (total > 0 ? count / total : 0) * ownerShare;
    const amount = goal.amount || (Number(next?.itemId) === itemId ? next.amount : 1);
    return perHour > 0 ? Math.max(1, positive(amount)) / perHour : null;
}

function soloItemRouteHours(state, spots, goal, timestamp) {
    const spot = invoke('GameServer/Bot/AI/SpotIndex').spotById(spots, goal?.spotId);
    if (!spot || spot.raidBoss || !Number(goal?.itemId)) return null;
    const standalone = soloState(state);
    const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
    const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
    if (!Routes.isSpotAllowedForState(spot, standalone, { timestamp, mode: 'solo',
        matchupProfiles: Match.stateProfiles(standalone, { timestamp }) })) return null;
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const evaluateSpot = SpotEconomics.create(standalone, { timestamp, moneyWeight: 1 });
    const choices = [true, false].map(shots => evaluateSpot(spot, shots)).filter(row => row?.income > 0)
        .map(row => itemHours(state, spot, row.kills * Hunt.onSpotShare(state), goal, [state]))
        .filter(hours => hours !== null);
    return choices.length ? Math.min(...choices) + walkHours(state, spot) : null;
}

function compare(state, peers, options = {}) {
    if (!adventurer(state) || options.objective?.clanGoalKey || options.objective?.sourceKind === 'raid') return null;
    if (!state.spotId || !Number.isFinite(Number(state.stats?.classId ?? state.classId))) return null;
    const members = [state, ...peers];
    const prepared = options.prepared || prepare(members, options);
    let solo = soloRoute(state, prepared.spots, prepared.timestamp, peers);
    // A guarded existing production quote can beat hunting. This is a read
    // of an already prepared native result, never a market/recipe scan here.
    const workshop = prepared.workshops?.get(state.characterId)
        || invoke('GameServer/Bot/Economy/EconomyContext').craftIncome(state);
    if (workshop?.known !== false && workshop?.incomePerHour > positive(solo?.income)
        && workshop.cycleHours > 0 && Number.isFinite(workshop.incomePerHour)) {
        solo = { income: workshop.incomePerHour, travelHours: 0, source: 'native_craft' };
    }
    const party = prepared.rows.get(state.characterId) || null;
    const focus = state.stats?.wishFocus;
    const materialParty = Material.isObjective(options.objective);
    const agreement = materialParty ? options.party?.stats?.agreement || Material.agreement(members, options.objective)
        : options.party?.stats?.agreement;
    const materialGoal = materialParty ? Material.needs(members, options.objective, agreement)
        .find(row => row.characterId === Number(state.characterId)) : null;
    const goal = materialGoal || state.stats?.partyRequest || state.stats?.equipmentPlan?.next || options.objective;
    const cash = materialParty ? materialGoal?.materialCash ?? null : positive(focus?.[2]) || null;
    const spendable = Math.max(0, positive(state.adena) - positive(state.stats?.money?.[2]));
    const help = options.party?.stats?.agreement?.help || options.objective?.helpDeal;
    const payer = Number(help?.payerId) === Number(state.characterId);
    const fee = help?.status === 'funded' ? 0 : payer ? positive(help?.fee) : 0;
    // A recipe/component delivery is not the completion of the final gear
    // purchase. Only compare direct item time for the focused equipment.
    const focusedItem = String(focus?.[0] || '').match(/^power:(\d+):/);
    const finalItem = materialParty ? !!materialGoal
        : Number(goal?.itemId) > 0 && (!focusedItem || Number(focusedItem[1]) === Number(goal.itemId));
    const partyItemHours = finalItem
        ? itemHours(state, prepared.spot, party?.kills, goal, members, agreement) : null;
    // The direct solo drop may be at a different camp from the best cash
    // route. Check just that known camp, without searching the source atlas.
    const held = soloChoices.get(state);
    const goalKey = finalItem ? `${goal.spotId}:${goal.npcId}:${goal.itemId}:${goal.strategy}:${goal.amount || 1}` : null;
    if (held && held.goalKey !== goalKey) {
        held.goalKey = goalKey;
        held.itemHours = finalItem ? soloItemRouteHours(state, prepared.spots, goal, prepared.timestamp) : null;
    }
    const soloItemHours = materialGoal?.materialSoloHours ?? (finalItem ? (held ? held.itemHours : soloItemRouteHours(state,
        prepared.spots, goal, prepared.timestamp)) ?? null : null);
    const payerState = members.find(member => Number(member.characterId) === Number(help?.payerId));
    const deliveryGoal = materialParty ? Material.needs(members, options.objective, agreement)
        .find(row => row.characterId === Number(help?.payerId)) : options.objective;
    const deliveryHours = payerState ? itemHours(payerState, prepared.spot, party?.kills, deliveryGoal,
        members, agreement) : null;
    const helpers = help?.status === 'funded' && Array.isArray(help.helperIds)
        ? help.helperIds.filter(id => members.some(member => Number(member.characterId) === Number(id))) : null;
    // Joining an existing hunt does not add a recipient to its funded escrow.
    const rewardFee = !payer && (!helpers || helpers.some(id => Number(id) === Number(state.characterId)))
        ? positive(helpers ? help.remaining ?? help.fee : help?.fee) / Math.max(1, helpers?.length ?? peers.length) : 0;
    const answer = evaluate({ solo, party, cash, spendable, fee, soloItemHours, partyItemHours, deliveryHours,
        rewardFee,
        assemblyHours: options.party ? 0 : positive(party?.travelHours) + 45000 / HOUR_MS });
    return { ...answer, at: prepared.timestamp, soloSource: solo?.source || null, partySource: party?.source || null };
}

module.exports = { soloHoldStats, compare, prepare, evaluate, soloRoute, itemHours, soloItemRouteHours, rosterKey, REVIEW_MS, MAX_SOLO_CHECKS };
