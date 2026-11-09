'use strict';
// Party value by progress: does a party bring this bot to its next level (and the
// piece its gear path saves for) sooner than its solo hunt? One pure comparison of
// table rows (SpotValueTable: the spot's hour of kills, exp and deaths), read by the
// party request (PartyRequestPlanner: a C4 player's LFP), forming's verdict and the
// recruit check (PartyGoalPolicy), the party's review and a member's stay
// (PartyStay, the worker's party step). Worker and main read the same functions.
const BuffPolicy = invoke('GameServer/Bot/Economy/BuffServicePolicy');
const Network = invoke('GameServer/Bot/Economy/WishNetwork');
const Rewards = require('../Economy/SpotRewardExpectation');
const Packet = require('../Economy/StatsPacket');
const GameDataCatalogue = require('../../Knowledge/GameDataCatalogue');
const Material = require('./CraftMaterialParty');
const SpotEconomics = require('../Economy/SpotEconomics');
const WalkBack = require('../Economy/WalkBack');
const PartyRewardMath = invoke('GameServer/Actor/PartyRewardMath');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const PartyRisk = require('./PartySpotRiskPolicy');
const HOUR_MS = 3600000;
const positive = value => Math.max(0, Number(value) || 0);
const rosterKey = members => members.map(member => Number(member.characterId)).sort((a, b) => a - b).join(',');
const adventurer = state => invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(state);
const soloState = state => ({ ...state, activity: 'hunting', partyId: null,
    party: { ...state.party, partyId: null }, stats: { ...state.stats, backgroundPartyId: null, routeMode: 'solo' } });

// Hours to the next level on a route: the exp still missing over its exp per hour,
// each hour's deaths adding their price (route.riskHours: the hours its deaths an
// hour cost the bot, SpotEconomics' riskHours, both sides by one reader). 0 with no
// level ahead (at the cap: evaluate then weighs money); null when the route gives no exp.
function levelHours(route, remaining) {
    if (!(remaining > 0)) return 0;
    if (!(route?.exp > 0)) return null;
    return remaining / route.exp * (1 + positive(route.riskHours));
}

// Pure comparison of the two sides in hours. A side's hours are its hours to the
// next level (levelHours; at the cap the hours to earn one sum, capped below) plus, only for a bot saving for its path's piece (cash:
// the price its held gear plan names and it cannot pay yet; item hours: the piece's
// own drop), the hours until it holds that piece: its income funding the price
// (fundingDelay, the trip to the camp when it must earn first) or the drop, the
// sooner. The party side adds its assembly. lean: the persona's weight on the party
// side's hours (partyLean). Accepts when the weighted party side is sooner, or the
// bot has no solo side at all (no solo ground, a piece only a party drops); never
// a party whose income for the bot is below nothing (party_at_loss).
function evaluate({ solo, party, remaining = 0, cash = null, spendable = 0, fee = 0, rewardFee = 0,
    soloItemHours = null, partyItemHours = null, deliveryHours = partyItemHours, assemblyHours = 0, lean = 1 } = {}) {
    const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation');
    const saving = cash !== null || soloItemHours !== null || partyItemHours !== null;
    const ready = (route, cashNow, direct) => {
        const funding = cash === null ? null : Valuation.fundingDelay({
            requiredCash: cash, spendableCash: cashNow, incomePerHour: route?.income || 0 });
        const choices = [funding === null ? null : funding + (funding > 0 ? positive(route?.travelHours) : 0), direct]
            .filter(hours => hours !== null && Number.isFinite(hours) && hours >= 0);
        return choices.length ? Math.min(...choices) : null;
    };
    const soloPiece = saving ? ready(solo, Math.max(0, spendable - positive(solo?.buffPrice)), soloItemHours) : 0;
    let partyPiece = saving ? ready(party, Math.max(0, spendable - positive(fee)), partyItemHours) : 0;
    if (saving && party?.income > 0 && cash !== null && deliveryHours !== null && Number.isFinite(deliveryHours)
        && rewardFee > 0) {
        // A promised helper payment is purchase cash after delivery, never at invitation time.
        const afterFee = Valuation.fundingDelay({ requiredCash: cash,
            spendableCash: spendable + rewardFee, incomePerHour: party.income });
        const paidReady = Math.max(deliveryHours, afterFee) + positive(party.travelHours);
        partyPiece = partyPiece === null ? paidReady : Math.min(partyPiece, paidReady);
    }
    const partyIncome = party ? Number(party.income) + (deliveryHours > 0
        ? positive(rewardFee) / (deliveryHours + positive(assemblyHours)) : 0) : null;
    // No level ahead (the level cap, Progression.contentCap) and nothing saved for:
    // the bot still gains money, so each side's hours are the hours it takes to
    // earn the same sum (the better side's hour of income), deaths adding their
    // time; a side that earns nothing never gets there (null). Our choice: a capped
    // C4 player hunts for adena and drops, and parties where they come sooner.
    const capped = !(remaining > 0) && !saving;
    const sum = capped ? Math.max(positive(solo?.income), positive(partyIncome)) : 0;
    const side = (route, piece, income = route?.income) => {
        if (capped) return Number(income) > 0 ? sum / Number(income) * (1 + positive(route.riskHours)) : null;
        const level = route ? levelHours(route, remaining) : null;
        return level === null || piece === null ? null : level + piece;
    };
    const soloHours = solo ? side(solo, soloPiece) : null;
    const partyRoute = party ? side(party, partyPiece, partyIncome) : null;
    const partyHours = partyRoute === null ? null : partyRoute + positive(assemblyHours);
    let reason = 'solo_sooner', accept = false;
    if (positive(fee) > positive(spendable)) reason = 'help_fee_unfunded';
    else if (!party || partyHours === null && soloHours === null) reason = 'progress_unknown';
    // A party must not cost the bot money: its share of the loot at least pays its
    // shots and potions (C4: a player leaves a party that drains his adena).
    else if (partyIncome < 0) reason = 'party_at_loss';
    else if (soloHours === null && partyHours !== null) { accept = true; reason = 'goal_requires_party'; }
    else if (partyHours !== null && partyHours * lean < soloHours) { accept = true; reason = 'party_sooner'; }
    return { accept, reason, soloIncome: solo ? Number(solo.income) : null,
        partyIncome, soloHours, partyHours, fee: positive(fee),
        soloSpotId: solo?.spotId || null, soloBuffPrice: positive(solo?.buffPrice) };
}

// The persona's weight on a party's hours: 1.5 - sociability (BotPersona traits,
// 0.18 for a lone wolf .. 0.82 for a party regular): a social bot takes a party up
// to ~1.5x slower than its solo hunt, a loner only one ~1.3x faster. Our choice.
function partyLean(state) {
    const sociability = Number(invoke('GameServer/Bot/AI/BotPersona').of(state)?.traits?.sociability);
    return 1.5 - (Number.isFinite(sociability) ? sociability : 0.5);
}

// The exp still missing to the next level (DataCache.experience: the total exp at
// each level's end), 0 at the level cap.
function remainingExp(state) {
    const level = Math.floor(Number(state.level) || 1);
    if (level >= invoke('GameServer/Progression/ProgressionCap').effectiveLevelCap()) return 0;
    const table = invoke('GameServer/DataCache').experience;
    return Math.max(0, Number(table?.[level]) - positive(state.stats?.exp ?? state.exp)) || 0;
}

// The party a bot asks for (its LFP, PartyRequestPlanner.progressObjective): itself
// and one partner of its level, a healer for any other bot (a C4 "LF healer"), a
// damage dealer for a healer: the table's reference bot of that line (HuntCycle:
// the author's kit and skill tree). Game data, kept per class and level (at most
// two lines x the levels: ~160 states). The partner's row is its solo kit's: the
// spot table simulates no party kit (a healer that heals instead of hunting), so a
// healer's party is forecast lower than the cold party round lives it (~0.7x for a
// healer and a damage dealer, ~1.3x for two damage dealers). The reference stays
// (not the pool around the bot): the ask is the bot's own LFP, the party a player
// would want at its spot; forming then judges the roster it really meets.
const partners = new Map();
function partnerFor(state) {
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const level = Math.max(1, Math.min(80, Math.floor(Number(state.level) || 1)));
    const classId = Number(Table.roleClass(Roles.isHealer(state) ? 'dps' : 'healer', level));
    if (!Number.isInteger(classId)) return null;
    const key = classId * 100 + level;
    let partner = partners.get(key);
    // One object per key: the combat profile readers keep their answer for it.
    if (!partner) partners.set(key, partner = Object.freeze(invoke('GameServer/Bot/AI/HuntCycle').referenceState(classId, level)));
    return partner;
}
// The solo side's earning route: the bot's held earning answer (situations step 1,
// stats.earning) at the inputs now (EquipmentIncomeRoute.heldRoute: one row
// evaluation, no search); null when it holds no answer (forming skips it,
// PartyGoalPolicy.formingMembers), none with a spot, or a support's grey ground
// (PartyRequestPlanner.supportWithoutGround: no solo ground, its solo hunt is none).
// values: the comparison's reader of the bot (soloValues), when it values its party hour beside.
function heldSoloRoute(state, spots, timestamp, values = null) {
    if (require('./PartyRequestPlanner').supportWithoutGround(state, spots)) return null; // lazy: the planner's chain loads this module
    return invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').heldRoute(soloState(state), { spots, timestamp, values });
}
// The bot's one spot reader for both sides (EquipmentIncomeRoute.valuesFor of its solo copy).
const soloValues = (state, timestamp) => invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').valuesFor(soloState(state), timestamp);
// The party side's route: the bot's hour of the party (prepare) valued by its own
// reader as its solo row is (belief bias, calibration of a forecast, death price),
// at its time on the spot. null: no hour.
function partyRoute(state, hour, spot, values) {
    const row = hour && spot && values.evaluate(spot, true, hour);
    if (!row) return null;
    const share = invoke('GameServer/Bot/AI/BotHuntEfficiency').onSpotShare(state);
    return { ...hour, income: row.income * share, exp: positive(row.exp) * share, deaths: positive(row.deaths) * share,
        riskHours: positive(row.riskHours) * share };
}

// choice: the member's held solo route when its caller already read it. The row's
// hour on the spot (its own samples, its crowd, its belief bias and death price,
// SpotEconomics) at the bot's time on the spot (onSpot): exp, income and the time
// its deaths take alike, as the party side's (partyRoute).
function soloRoute(state, spots, timestamp, peers = [], choice = heldSoloRoute(state, spots, timestamp)) {
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const standalone = soloState(state);
    if (!choice) return null;
    const row = choice.row, share = Hunt.onSpotShare(state);
    let best = { ...row, income: choice.earning * share, exp: positive(row.exp) * share, deaths: positive(row.deaths) * share,
        riskHours: positive(row.riskHours) * share, spotId: choice.spot.id,
        travelHours: WalkBack.tripHours(state.loc, choice.spot, state, spots), source: 'solo_route', buffPrice: 0 };
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
        const boost = Math.min(gain, 300 / Math.max(1, row.kills));
        const income = (row.income * boost - price / duration) * share;
        if (income > best.income) best = { ...best, income, exp: positive(row.exp) * boost * share, buffPrice: price, source: 'paid_buff' };
        break;
    }
    return best;
}

function withEffects(state, effects) {
    const Loadout = invoke('GameServer/Bot/AI/PartyBuffLoadout');
    const families = new Set(effects.map(effect => Loadout.family(effect.key)));
    return { ...state, stats: { ...state.stats, coldCombat: { ...state.stats?.coldCombat,
        effects: [...(state.stats?.coldCombat?.effects || []).filter(effect => !families.has(Loadout.family(effect.key))), ...effects] } } };
}

// A party's kills per hour from its members' kills (prepare's cycles: fight, rest,
// walk and cap seconds of each one's table row; null for a member without one), by
// the cold party round's terms (BackgroundPartyResolver.partyRound): one walk per
// kill, the shortest (the first to reach a mob engages it); the fight at the members'
// damage together (damage rates add: 1 / sum of 1 / fight); the rest the party sits
// together per kill, the longest of the members', each scaled to the shorter fight
// (the HP taken and the MP spent follow the fight's time); at most the highest cap
// (the party takes the mobs any member may). One member: its own row's kills.
function partyKills(cycles) {
    let rate = 0, walk = Infinity, cap = 0;
    for (const cycle of cycles) {
        if (!cycle) continue;
        rate += 1 / cycle.fight;
        walk = Math.min(walk, cycle.walk);
        cap = Math.max(cap, cycle.cap);
    }
    if (!(rate > 0)) return 0;
    const fight = 1 / rate;
    let rest = 0;
    for (const cycle of cycles) if (cycle) rest = Math.max(rest, cycle.rest * fight / cycle.fight);
    const kills = 3600 / Math.max(1e-9, walk + fight + rest);
    return cap > 0 ? Math.min(cap, kills) : kills;
}

// One bounded forecast for a complete roster. Static point lookups are
// cached by role/level/rates in SpotValueTable. No wish graph or combat roll.
function prepare(members, { objective, party, spots, timestamp } = {}) {
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
    // A party's healer heals what the others take (a C4 party takes one for it): a
    // member that does not rest for mana fights on without its rest and does not
    // die of the damage. Our choice: no heal model beyond.
    const healed = members.map((member, index) => !Roles.shouldRestForMana(member)
        && members.some((peer, other) => other !== index && Roles.isHealer(peer)));
    const values = members.map(member => Table.value(spot.id, Table.roleFor(member), member.level, true,
        { spoilSkillLevel: Rewards.spoilSkillLevel(member) }));
    // Each member's kill of its table row (SpotValueTable.cycle: the reference's fight,
    // rest and walk at the member's level), its fight shortened by the damage a native
    // buff adds (buff stats change damage throughput, never drop rates or the member's
    // ownership share).
    const cycles = members.map((member, index) => {
        if (!values[index]) return null;
        const cycle = Table.cycle(spot.id, Table.roleFor(member), member.level, true,
            { spoilSkillLevel: Rewards.spoilSkillLevel(member) });
        if (!(cycle?.kph > 0) || !(cycle.fight > 0)) return null;
        let fight = cycle.fight;
        if (buffed[index] !== member) {
            const damage = Match.damageRate(Match.stateProfiles(member, { timestamp, buffed: true }));
            const gain = damage > 0 ? Match.damageRate(Match.stateProfiles(buffed[index], { timestamp, buffed: true })) / damage : 1;
            fight /= Math.max(1, gain);
        }
        const rest = positive(cycle.rest);
        return { fight, rest: healed[index] ? 0 : rest,
            walk: Math.max(0, 3600 / cycle.kph - cycle.fight - rest), cap: positive(cycle.cap) };
    });
    const gross = Table.value(spot.id, 'dps', level, true) || Table.value(spot.id, 'mage', level, true);
    const safe = Match.spotMatchup(spot, Match.stateProfiles(buffed[0],
        { timestamp, capacityStates: buffed, mode: 'party', buffed: true }), { soloSafety: true }).eligible;
    // The party's share of the spot: what the spawns its members may fight give back (the
    // highest production of their rows), the party alone on it, as a solo bot's value shares
    // a spot only with its own party (SpotEconomics); its kills are cut to it. The live crowd
    // is met at arrival, never valued. Counted as party_value:crowd:cut (developer diagnostics).
    const forecast = partyKills(cycles);
    const crowd = Table.huntShare(Math.max(0, ...values.map(row => positive(row?.production))), 1, forecast);
    if (crowd < 1) invoke('GameServer/Bot/Economy/EconomyDiagnostics').count('party_value', 'crowd', 'cut');
    const kills = forecast * crowd;
    // A member's share of the party's kills: its share of their damage.
    const rate = cycles.reduce((sum, cycle) => sum + (cycle ? 1 / cycle.fight : 0), 0);
    // The party's exp (C4, L2J Lisvus L2Party.distributeXpAndSp: each kill's exp at
    // the party's top level, times the party bonus by members, split by squared
    // level, low members cut off: PartyRewardMath, the cold party's own split).
    const expShares = gross?.kills > 0 && kills > 0 ? PartyRewardMath.sharesForLevels(members.map(member => positive(member.level) || 1),
        kills * positive(gross.exp) / gross.kills, 0) : [];
    const expOf = new Map(expShares.map(share => [share.index, share.exp]));
    // The party's own deaths at the spot (its risk window for this roster,
    // PartySpotRiskPolicy) once it has fought there, a member's share of them a fight.
    const window = party ? PartyRisk.spotRisk(party) : null;
    const seen = String(window?.spotId) === String(spot.id) && window.windowFights > 0
        ? positive(window.windowDeaths) / window.windowFights / members.length : null;
    // Each member's hour on the spot (compare values it by the member's own reader,
    // partyRoute): its own party samples with this roster, else the forecast.
    const rows = new Map();
    for (let index = 0; index < members.length; index++) {
        const member = members[index], raw = values[index];
        // Its own row's deaths per kill over its share of the party's kills; none healed.
        const share = cycles[index] && rate > 0 ? 1 / cycles[index].fight / rate : 0;
        const deathsOf = hourKills => seen !== null ? hourKills * seen
            : healed[index] || !(raw?.kills > 0) ? 0 : positive(raw.deaths) / raw.kills * kills * share;
        const observed = Hunt.sampledRows(member, timestamp, 'party')
            .find(sample => sample.spotId === spot.id && sample.partyRoster === key);
        if (observed) {
            const perHour = HOUR_MS / observed.cycleMs, hourKills = positive(observed.kills) * perHour;
            rows.set(member.characterId, { measured: true, kills: hourKills, exp: positive(observed.exp) * perHour,
                adena: positive(observed.adena) * perHour, loot: positive(observed.loot) * perHour,
                costs: positive(observed.costs) * perHour, deaths: deathsOf(hourKills), spotId, source: 'own_party', travelHours: 0 });
            continue;
        }
        if (!safe || !gross?.kills || !raw?.kills || !share || !kills) continue;
        const expected = Rewards.value(spot, level, { spoilSkillLevel: index === spoilerIndex ? Rewards.spoilSkillLevel(member) : 0,
            spoilerLevel: member.level });
        const drop = expected ? expected.drop : (gross.dropLoot ?? gross.loot) / gross.kills;
        // Spoil stays with its spoiler under the native party agreement.
        const spoil = expected?.spoil || 0;
        rows.set(member.characterId, { kills, exp: positive(expOf.get(index)),
            adena: kills * (expected?.adena ?? gross.adena / gross.kills) / members.length, loot: kills * (drop / members.length + spoil),
            shots: kills * share * positive(raw.shots) / raw.kills, potions: kills * share * positive(raw.potions) / raw.kills,
            deaths: deathsOf(kills), spotId, source: 'table_party', travelHours: WalkBack.tripHours(member.loc, spot, member, spots) });
    }
    return { rows, spots, timestamp, spot, roster: key };
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
    return choices.length ? Math.min(...choices) + WalkBack.tripHours(state.loc, spot, state, spots) : null;
}

// The focused gear's item (a power focus), else 0.
function focusedItem(state) {
    const focus = state.stats?.wishFocus?.[0];
    return String(focus).startsWith('power:') ? Network.rootItem(focus) : 0;
}

// The goal the comparison times for one member (compare): a material party's
// need of it, else its party request, its gear plan's next step, the
// objective; final: the goal is the focused gear itself (a recipe or
// component delivery is not the completion of the final gear purchase: only
// the focused equipment compares direct item time). A request that only meets
// at a spot (no solo ground, party progress) names no item: the member saves for
// its plan's step all the same, so the goal reads past it.
function goalOf(state, members, objective, agreement) {
    const materialParty = Material.isObjective(objective);
    const materialGoal = materialParty ? Material.needs(members, objective, agreement)
        .find(row => row.characterId === Number(state.characterId)) : null;
    const request = state.stats?.partyRequest;
    const asked = request && !require('./PartyRequestPlanner').meetsAtSpot(request) ? request : null; // lazy: the planner's chain loads this module
    const goal = materialGoal || asked || state.stats?.equipmentPlan?.next || objective;
    const focused = focusedItem(state);
    return { materialGoal, goal, final: materialParty ? !!materialGoal
        : Number(goal?.itemId) > 0 && (!focused || focused === Number(goal.itemId)) };
}

// The direct solo drop's hours for a goal of goalOf: a material need's own
// quote; else, for the final gear, the goal's known camp (it may differ from
// the best cash route's), checked there without searching the source atlas
// (soloItemRouteHours); null otherwise. Kept per bot with the earning spot's
// held answer it was read beside (the answer's time, the goal, the catalogue):
// taken again when the bot decided its earning spot again (a level up, new
// gear, a death...) or its goal moved, not when only prices or samples moved
// between those situations (they go stale until then, as the held answer's).
// At most GOAL_HOURS_LIMIT bots (limits.md), the least recently read out.
const GOAL_HOURS_LIMIT = 2048;
const goalHours = new Map();
function soloGoalHours(state, aim, spots, timestamp) {
    if (aim.materialGoal?.materialSoloHours != null) return aim.materialGoal.materialSoloHours;
    if (!aim.final) return null;
    const goal = aim.goal, id = Number(state.characterId) || 0;
    const key = `${state.stats?.earning?.at ?? 'none'}:${goal.spotId}:${goal.npcId}:${goal.itemId}:${goal.strategy}:${goal.amount || 1}`;
    let kept = goalHours.get(id);
    if (kept?.key !== key || kept.spots !== spots) kept = { key, spots, hours: soloItemRouteHours(state, spots, goal, timestamp) };
    goalHours.delete(id); goalHours.set(id, kept);
    if (goalHours.size > GOAL_HOURS_LIMIT) {
        goalHours.delete(goalHours.keys().next().value);
        invoke('GameServer/Bot/Economy/EconomyDiagnostics').count('party_goal_hours', 'evicted');
    }
    return kept.hours ?? null;
}

// A forming party hunts from its first step, which comes the party resolve's wait after
// its formation (BackgroundPartyResolver: the minimum plus up to the spread); the ask
// counts the mean of that wait (our choice, not C4).
let firstStep = null;
function firstStepHours() {
    if (firstStep === null) {
        const { PARTY_RESOLVE_MIN_MS, PARTY_RESOLVE_SPREAD_MS } = require('./BackgroundPartyResolver'); // lazy: the resolver's chain loads this module
        firstStep = (PARTY_RESOLVE_MIN_MS + PARTY_RESOLVE_SPREAD_MS / 2) / HOUR_MS;
    }
    return firstStep;
}

function compare(state, peers, options = {}) {
    if (!adventurer(state) || options.objective?.clanGoalKey || options.objective?.sourceKind === 'raid') return null;
    if (!state.spotId || !Number.isFinite(Number(state.stats?.classId ?? state.classId))) return null;
    const members = [state, ...peers];
    const prepared = options.prepared || prepare(members, options);
    const id = Number(state.characterId), hour = prepared.rows.get(state.characterId);
    // One reader of the bot values both sides (crowd, belief bias, death source and price).
    let values = null;
    const reader = () => values ||= soloValues(state, prepared.timestamp);
    const held = options.solo?.has(id) ? options.solo.get(id) : heldSoloRoute(state, prepared.spots, prepared.timestamp,
        hour ? reader() : null);
    const solo = soloRoute(state, prepared.spots, prepared.timestamp, peers, held);
    const party = hour ? partyRoute(state, hour, prepared.spot, reader()) : null;
    const materialParty = Material.isObjective(options.objective);
    const agreement = materialParty ? options.party?.stats?.agreement || Material.agreement(members, options.objective)
        : options.party?.stats?.agreement;
    const aim = goalOf(state, members, options.objective, agreement), { materialGoal, goal } = aim;
    const spendable = Math.max(0, positive(state.adena) - positive(Packet.refillReserve(state.stats?.money)));
    // Saving for its path's piece: the price its build armed as the next it cannot
    // pay (DecisionSections.affordAtOf, kind focus: the weapon bridge or the nearer
    // of the focus and the gear plan's market piece); a material need's own cash.
    const afford = state.stats?.wishSections?.affordAt;
    const cash = materialGoal ? materialGoal.materialCash ?? null
        : afford?.kind === 'focus' && positive(afford.at) > spendable ? positive(afford.at) : null;
    const help = options.party?.stats?.agreement?.help || options.objective?.helpDeal;
    const payer = Number(help?.payerId) === Number(state.characterId);
    const fee = help?.status === 'funded' ? 0 : payer ? positive(help?.fee) : 0;
    const partyItemHours = aim.final
        ? itemHours(state, prepared.spot, party?.kills, goal, members, agreement) : null;
    const soloItemHours = soloGoalHours(state, aim, prepared.spots, prepared.timestamp);
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
    const answer = evaluate({ solo, party, remaining: remainingExp(state), cash, spendable, fee, soloItemHours, partyItemHours,
        deliveryHours, rewardFee, lean: partyLean(state),
        assemblyHours: options.party ? 0 : positive(party?.travelHours) + firstStepHours() });
    return { ...answer, at: prepared.timestamp, soloSource: solo?.source || null, partySource: party?.source || null };
}

module.exports = { compare, prepare, evaluate, levelHours, partyLean, partnerFor, heldSoloRoute, soloRoute, itemHours, soloItemRouteHours, focusedItem, goalOf, soloGoalHours, rosterKey, soloState };
