const ProgressionRates = invoke('GameServer/ProgressionRates');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');

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

function disposableAdena(state = {}, config = Config) {
    const adena = walletAdena(state);
    const reserve = personalReserve(state, config);
    return {
        adena,
        reserve,
        disposable: Math.max(0, adena - reserve)
    };
}

function scaledAdenaRequirement(level = 0, rates = ProgressionRates.profile(), config = Config) {
    const base = Number(level) <= 0 ? config.levelOneAdenaBase : config.levelTwoAdenaBase;
    const rate = Math.max(0.01, number(rates?.adena, 1));
    const exponent = Math.max(0, number(config.adenaRateExponent, 0.59));
    return Math.max(1, Math.ceil(Math.max(0, number(base)) * Math.pow(rate, exponent)));
}

function contributionCap(state, config = Config) {
    const wallet = disposableAdena(state, config);
    const fraction = Math.max(0, Math.min(1, number(config.contributionMaxFraction, 0.35)));
    return {
        ...wallet,
        maxContribution: Math.floor(wallet.disposable * fraction)
    };
}

function planContributions(members = [], {
    leaderId,
    requiredAmount,
    contributedAmount = 0,
    config = Config
} = {}) {
    const shortfall = Math.max(0, Math.floor(number(requiredAmount) - number(contributedAmount)));
    if (shortfall <= 0) return { shortfall: 0, totalCapacity: 0, contributions: [] };

    const candidates = members
        .filter((member) => number(member.characterId ?? member.id) > 0)
        .filter((member) => number(member.characterId ?? member.id) !== number(leaderId))
        .map((member) => ({
            member,
            characterId: number(member.characterId ?? member.id),
            cap: contributionCap(member.state || member, config)
        }))
        .filter((entry) => entry.cap.maxContribution > 0)
        .sort((left, right) => right.cap.maxContribution - left.cap.maxContribution
            || left.characterId - right.characterId);

    const totalCapacity = candidates.reduce((sum, entry) => sum + entry.cap.maxContribution, 0);
    if (totalCapacity <= 0) return { shortfall, totalCapacity: 0, contributions: [] };

    let remaining = shortfall;
    const contributions = candidates.map((entry) => {
        const amount = Math.min(entry.cap.maxContribution, Math.floor(shortfall * entry.cap.maxContribution / totalCapacity));
        remaining -= amount;
        return {
            characterId: entry.characterId,
            amount,
            reserve: entry.cap.reserve,
            disposable: entry.cap.disposable,
            maxContribution: entry.cap.maxContribution
        };
    });

    // Integer rounding must not strand a small shortfall when a contributor
    // still has capacity. The order is deterministic so retries produce the
    // same ledger shape.
    while (remaining > 0) {
        let progressed = false;
        for (const entry of contributions) {
            const room = Math.max(0, entry.maxContribution - entry.amount);
            if (room <= 0) continue;
            const increment = Math.min(room, remaining);
            entry.amount += increment;
            remaining -= increment;
            progressed = true;
            if (remaining <= 0) break;
        }
        if (!progressed) break;
    }

    return {
        shortfall,
        totalCapacity,
        plannedAmount: contributions.reduce((sum, entry) => sum + entry.amount, 0),
        contributions: contributions.filter((entry) => entry.amount > 0)
    };
}

module.exports = {
    walletAdena,
    personalReserve,
    disposableAdena,
    scaledAdenaRequirement,
    contributionCap,
    planContributions
};
