const ProgressionRates = invoke('GameServer/ProgressionRates');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function walletAdena(state = {}) {
    return Math.max(
        0,
        number(state.adena),
        number(state.inventory?.['57']?.amount),
        number(state.inventory?.[57]?.amount)
    );
}

function personalReserve(state = {}, config = Config) {
    const adena = walletAdena(state);
    const level = Math.max(1, number(state.level, 1));
    const baseline = Math.max(500, level * 250, Math.ceil(adena * 0.10));
    return Math.ceil(baseline * Math.max(0, number(config.personalAdenaReserveMultiplier, 1)));
}

function scaledAdenaRequirement(level = 0, rates = ProgressionRates.profile(), config = Config) {
    const base = Number(level) <= 0 ? config.levelOneAdenaBase : config.levelTwoAdenaBase;
    const rate = Math.max(0.01, number(rates?.adena, 1));
    const exponent = Math.max(0, number(config.adenaRateExponent, 0.59));
    return Math.max(1, Math.ceil(Math.max(0, number(base)) * Math.pow(rate, exponent)));
}

const clamp01 = (value) => Math.max(0, Math.min(1, number(value, 0)));
const trait = (traits, name) => clamp01(traits?.[name] ?? 0.5);

// How readily a member gives to the clan: empathy, commitment and sociability.
// 0 at a generosity of 0.4 or less, 1 at 0.7 or more.
function giveFactor(traits = {}) {
    const generosity = (trait(traits, 'empathy') + trait(traits, 'commitment') + trait(traits, 'sociability')) / 3;
    return clamp01((generosity - 0.4) / 0.3);
}

// Share of the market price a member asks the clan for a spare item (0 = a gift).
function askedShare(traits = {}) {
    return 1 - giveFactor(traits);
}

// The clan's dues on new earnings: 10%, plus up to 20% by its members' mean ambition.
function duesRate(memberTraits = []) {
    const ambition = memberTraits.length
        ? memberTraits.reduce((sum, traits) => sum + trait(traits, 'ambition'), 0) / memberTraits.length
        : 0.5;
    return 0.10 + 0.20 * clamp01((ambition - 0.55) / 0.30);
}

// A member's rate: the clan's dues plus a voluntary top-up of up to 15% by its
// generosity, the top-up only while the member is not about to buy its own gear;
// at most contributionMaxFraction (35%).
function memberRate(clanRate, traits = {}, state = null, config = Config) {
    const buying = ownGearPurchase(state) === 'funded';
    return Math.min(number(config.contributionMaxFraction, 0.35), clanRate + (buying ? 0 : 0.15 * giveFactor(traits)));
}

// The member's own pending gear purchase: 'funded' (its money covers the price
// above the operating reserve), 'short' (saving for it) or null.
function ownGearPurchase(state = null) {
    const plan = state?.stats?.equipmentPlan;
    if (plan?.strategy !== 'market' || !(number(plan.market?.price) > 0)) return null;
    // The plan's own reserve (a weapon bridge keeps a smaller one), as the goal review reads it.
    const reserve = number(plan.market.reserve) || PurchaseFunding.operatingReserve(state || {});
    return PurchaseFunding.shortfall(state || {}, plan.market.price, reserve) === 0 ? 'funded' : 'short';
}

// Share of its free savings a member puts once into the clan's current target:
// up to contributionMaxFraction, by commitment and ambition. Like the top-up, it
// waits while the member is about to buy its own gear: the target stays open for
// it, so it invests at the first settlement after the purchase.
function investFraction(traits = {}, state = null, config = Config) {
    if (ownGearPurchase(state) === 'funded') return 0;
    return number(config.contributionMaxFraction, 0.35) * (trait(traits, 'commitment') + trait(traits, 'ambition')) / 2;
}

module.exports = {
    walletAdena,
    personalReserve,
    scaledAdenaRequirement,
    giveFactor,
    askedShare,
    duesRate,
    memberRate,
    ownGearPurchase,
    investFraction
};
