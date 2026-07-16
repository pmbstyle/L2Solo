const DataCache = invoke('GameServer/DataCache');
const ProgressionRates = invoke('GameServer/ProgressionRates');

function randInt(rng, min, max) {
    const low = Math.max(0, Number(min) || 0);
    const high = Math.max(low, Number(max) || low);
    return Math.floor(rng() * (high - low + 1)) + low;
}

function rewardDataForSpot(spot, rng) {
    const byId = (spot?.npcSelfIds || [])
        .map((selfId) => (DataCache.npcRewards || []).find((reward) => Number(reward.selfId) === Number(selfId)))
        .filter((reward) => Array.isArray(reward?.rewards) && reward.rewards.length > 0);
    const knownIds = new Set(byId.map((reward) => Number(reward.selfId)));
    const names = new Set((spot?.npcNames || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean));
    // World-spawn ids may not be the datapack reward ids. The spot index also
    // carries the monster names, so use that source-backed mapping before
    // giving up on loot for the fight.
    const byName = names.size === 0 ? [] : (DataCache.npcRewards || []).filter((reward) => (
        !knownIds.has(Number(reward.selfId))
        && names.has(String(reward.template?.name || '').trim().toLowerCase())
        && Array.isArray(reward.rewards) && reward.rewards.length > 0
    ));
    const candidates = [...byId, ...byName];
    if (!candidates.length) return null;
    return candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
}

function selectItem(items, rng) {
    let partition = 0;
    const roll = rng() * 100;
    for (const item of items || []) {
        partition += Number(item.chance || 0);
        if (roll <= partition) return item;
    }
    return null;
}

function itemSnapshot(item, amount) {
    const template = (DataCache.items || []).find((entry) => Number(entry.selfId) === Number(item.selfId));
    if (!template || template.template?.kind === 'Other.Quest') return null;
    return {
        selfId: Number(item.selfId),
        name: item.name || template.template?.name || `Item ${item.selfId}`,
        amount,
        kind: template.template?.kind || '',
        rank: template.etc?.rank || 'none'
    };
}

function rollForFight({ spot, killerLevel, rng = Math.random, maxItems = 1 } = {}) {
    const rewardData = rewardDataForSpot(spot, rng);
    if (!rewardData) return [];

    const drops = [];
    for (const group of rewardData.rewards || []) {
        if (drops.length >= maxItems) break;
        if ((group.items || []).every((item) => Number(item.selfId) === 57)) continue;

        const groupRoll = ProgressionRates.rewardGroupRoll(group, 'drop', {
            npcLevel: Number(spot?.avgLevel || 0),
            killerLevel: Number(killerLevel || 0)
        }, rng);
        if (!groupRoll.hit) continue;

        const item = selectItem(group.items, rng);
        if (!item || Number(item.selfId) === 57) continue;
        const amount = ProgressionRates.scaleAmount(randInt(rng, item.min, item.max), groupRoll.amountMultiplier, rng);
        const snapshot = itemSnapshot(item, amount);
        if (snapshot) drops.push(snapshot);
    }
    return drops;
}

module.exports = { rollForFight };
