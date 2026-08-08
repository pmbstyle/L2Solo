const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');

const CONFIGURED_MERCHANT_NAMES = Object.freeze(Object.keys(MerchantStoreConfigs));
const configuredMerchantLookup = new Set(CONFIGURED_MERCHANT_NAMES.map((name) => name.toLowerCase()));

function subjectName(subject = {}) {
    const candidate = subject || {};
    const direct = candidate.merchantConfigName || candidate.name || candidate.characterName || candidate.botName;
    if (direct) return String(direct);
    if (candidate.actor?.fetchName) return String(candidate.actor.fetchName());
    return '';
}

function hasStaticCraftMarker(subject = {}) {
    const candidate = subject || {};
    const statsSources = [candidate.stats, candidate.coldCraftState?.stats, candidate.coldLifeState?.stats];
    return statsSources.some((stats) => stats?.craftStationId || stats?.craftShop)
        || Boolean(candidate.manufactureShop);
}

function isConfiguredMerchant(subject = {}) {
    const name = subjectName(subject).trim().toLowerCase();
    return name.length > 0 && configuredMerchantLookup.has(name);
}

function isStaticService(subject = {}) {
    const candidate = subject || {};
    if (candidate.staticService === true || isConfiguredMerchant(candidate) || hasStaticCraftMarker(candidate)) return true;

    // A permanent private store has no cold adventurer snapshot. Dynamic
    // WTS/WTB and crafting bots keep one and remain ordinary simulated players.
    return candidate.plan === 'merchant'
        && !candidate.coldMarketState
        && !candidate.coldCraftState
        && !candidate.coldLifeState;
}

module.exports = {
    configuredMerchantNames: () => [...CONFIGURED_MERCHANT_NAMES],
    isConfiguredMerchant,
    isStaticService
};
