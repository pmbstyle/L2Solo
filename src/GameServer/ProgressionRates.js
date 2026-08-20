const PRESETS = {
    x1: { label: 'x1', multiplier: 1 },
    x10: { label: 'x10', multiplier: 10 },
    x50: { label: 'x50', multiplier: 50 }
};

const DEEP_BLUE_LEVEL_GAP = 9;
const DEEP_BLUE_PENALTY_PER_LEVEL = 9;
const DEEP_BLUE_CHANCE_DIVISOR = 3;
// L2DropData.MAX_CHANCE is 1,000,000 in Lisvus, whose post-rounding floor is 1.
const MIN_DEEP_BLUE_CHANCE = 0.0001;

function numberOr(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizePreset(value) {
    const key = String(value || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(PRESETS, key) ? key : 'x1';
}

function selectedPreset() {
    return normalizePreset(process.env.L2NODE_PROGRESSION_RATE || options.default.General?.progressionPreset);
}

function profile() {
    const preset = PRESETS[selectedPreset()];
    const general = options.default.General || {};
    const multiplier = preset.multiplier;

    return {
        preset: preset.label,
        multiplier,
        exp: numberOr(general.expRate, 1) * multiplier,
        sp: numberOr(general.spRate ?? general.expRate, 1) * multiplier,
        adena: numberOr(general.adenaRate, 1) * multiplier,
        drop: numberOr(general.dropChanceRate, 1) * multiplier,
        spoil: numberOr(general.spoilRate ?? general.dropChanceRate, 1) * multiplier,
        questDrop: numberOr(general.questDropRate ?? general.dropChanceRate, 1) * multiplier,
        questReward: numberOr(general.questRewardRate, 1) * multiplier,
        questAdena: numberOr(general.questAdenaRate ?? general.questRewardRate, 1) * multiplier,
        questExp: numberOr(general.questExpRate ?? general.questRewardRate, 1) * multiplier,
        questSp: numberOr(general.questSpRate ?? general.questRewardRate, 1) * multiplier
    };
}

function groupRate(group, kind = 'drop') {
    const current = profile();
    const hasAdena = (group.items || []).some((item) => Number(item.selfId) === 57);
    if (hasAdena) return current.adena;
    return kind === 'spoil' ? current.spoil : current.drop;
}

function rollGroup(overall, rate, rng = Math.random, minimumChance = 0) {
    const scaled = Math.max(0, Number(overall) || 0) * numberOr(rate, 1);
    const chance = Math.min(100, Math.max(Math.max(0, Number(minimumChance) || 0), scaled));

    return {
        hit: chance > 0 && rng() * 100 <= chance,
        chance,
        amountMultiplier: amountMultiplier(overall, rate)
    };
}

function amountMultiplier(overall, rate) {
    const scaled = Math.max(0, Number(overall) || 0) * numberOr(rate, 1);
    return Math.max(1, scaled / 100);
}

function dropItemBaseChance(group, item) {
    const groupChance = Math.max(0, Number(group?.overall) || 0);
    const itemShare = Math.max(0, Number(item?.chance) || 0);
    return groupChance * itemShare / 100;
}

function dropItemSelectionWeight(group, item, rate) {
    return Math.min(100, dropItemBaseChance(group, item) * numberOr(rate, 1));
}

function dropItemSelectionChance(group, item, rate) {
    const total = (group?.items || []).reduce((sum, candidate) => (
        sum + dropItemSelectionWeight(group, candidate, rate)
    ), 0);
    return total > 0 ? dropItemSelectionWeight(group, item, rate) / total : 0;
}

function dropAmountBounds(item) {
    const min = Math.max(0, Math.floor(Number(item?.min) || 0));
    return { min, max: Math.max(min, Math.floor(Number(item?.max) || min)) };
}

function expectedDropAmount(group, item, rate) {
    const repeats = Math.max(1, dropItemBaseChance(group, item) * numberOr(rate, 1) / 100);
    const { min, max } = dropAmountBounds(item);
    return repeats * (min + max) / 2;
}

function selectDropItem(group, rate, rng = Math.random) {
    const weighted = (group?.items || []).map((item) => ({
        item,
        weight: dropItemSelectionWeight(group, item, rate)
    })).filter((entry) => entry.weight > 0);
    const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    if (total <= 0) return null;

    const roll = rng() * total;
    let partition = 0;
    for (const entry of weighted) {
        partition += entry.weight;
        if (roll < partition) return entry.item;
    }
    return weighted[weighted.length - 1].item;
}

function rollDropAmount(group, item, rate, rng = Math.random) {
    const scaledChance = Math.max(100, dropItemBaseChance(group, item) * numberOr(rate, 1));
    const guaranteed = Math.floor(scaledChance / 100);
    const remainder = scaledChance - guaranteed * 100;
    const repeats = guaranteed + (rng() * 100 < remainder ? 1 : 0);
    const { min, max } = dropAmountBounds(item);
    let amount = 0;

    for (let index = 0; index < repeats; index++) {
        amount += min === max ? min : Math.floor(rng() * (max - min + 1)) + min;
    }
    return Math.max(1, amount);
}

function deepBlueRule({ npcLevel, killerLevel, attackerLevels = [] } = {}) {
    const levels = [killerLevel, ...attackerLevels]
        .map((level) => Number(level))
        .filter((level) => Number.isFinite(level) && level > 0);
    const highestLevel = levels.length > 0 ? Math.max(...levels) : 0;
    const normalizedNpcLevel = Number(npcLevel);
    const levelGap = Number.isFinite(normalizedNpcLevel) && normalizedNpcLevel > 0
        ? highestLevel - normalizedNpcLevel
        : 0;

    if (levelGap < DEEP_BLUE_LEVEL_GAP) {
        return { active: false, highestLevel, levelGap, penaltyPercent: 0, chanceMultiplier: 1, minimumChance: 0 };
    }

    const penaltyPercent = (levelGap - (DEEP_BLUE_LEVEL_GAP - 1)) * DEEP_BLUE_PENALTY_PER_LEVEL;
    return {
        active: true,
        highestLevel,
        levelGap,
        penaltyPercent,
        chanceMultiplier: Math.max(0, (100 - penaltyPercent) / 100) / DEEP_BLUE_CHANCE_DIVISOR,
        minimumChance: MIN_DEEP_BLUE_CHANCE
    };
}

function rewardGroupRoll(group, kind = 'drop', context = {}, rng = Math.random) {
    const current = profile();
    const rule = deepBlueRule(context);
    const baseRate = groupRate(group, kind);
    let rate = baseRate;

    if (rule.active) {
        rate *= rule.chanceMultiplier;
        // Lisvus divides deep-blue Adena by RateDropItems before applying RateDropAdena.
        // This keeps a shared high-rate preset from cancelling the retail penalty.
        if ((group.items || []).some((item) => Number(item.selfId) === 57)) {
            rate = current.drop > 0 ? rate / current.drop : 0;
        }
    }

    const roll = rollGroup(group.overall, rate, rng, rule.minimumChance);
    // Lisvus applies the Deep Blue modifier to categorized normal-drop chance,
    // but still calculates a selected item's high-rate quantity from its base rate.
    const amountRate = rule.active && kind === 'drop' ? baseRate : rate;
    return { ...roll, amountMultiplier: amountMultiplier(group.overall, amountRate), itemRate: baseRate, rule };
}

function scaleAmount(amount, amountMultiplier, rng = Math.random) {
    const scaled = Math.max(0, Number(amount) || 0) * Math.max(1, Number(amountMultiplier) || 1);
    const whole = Math.floor(scaled);
    const fraction = scaled - whole;
    return Math.max(1, whole + (rng() < fraction ? 1 : 0));
}

module.exports = {
    PRESETS,
    normalizePreset,
    selectedPreset,
    profile,
    groupRate,
    rollGroup,
    dropItemBaseChance,
    dropItemSelectionWeight,
    dropItemSelectionChance,
    expectedDropAmount,
    selectDropItem,
    rollDropAmount,
    deepBlueRule,
    rewardGroupRoll,
    scaleAmount
};
