const DataCache = invoke('GameServer/DataCache');
const ProgressionRates = invoke('GameServer/ProgressionRates');

function randInt(rng, min, max) {
    const low = Math.max(0, Number(min) || 0);
    const high = Math.max(low, Number(max) || low);
    return Math.floor(rng() * (high - low + 1)) + low;
}

function rewardDataForSpot(spot, rng, npcSelfId = 0) {
    const entries = spot?.npcEntries?.length
        ? spot.npcEntries
        : (spot?.npcSelfIds || []).map((selfId) => ({ selfId, count: 1 }));
    const byId = entries.map((entry) => ({
        reward: (DataCache.npcRewards || []).find((reward) => Number(reward.selfId) === Number(entry.selfId)),
        count: Math.max(1, Number(entry.count || 1))
    })).filter((entry) => Array.isArray(entry.reward?.rewards) && entry.reward.rewards.length > 0);
    const knownIds = new Set(byId.map((entry) => Number(entry.reward.selfId)));
    const names = new Set((spot?.npcNames || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean));
    // World-spawn ids may not be the datapack reward ids. The spot index also
    // carries the monster names, so use that source-backed mapping before
    // giving up on loot for the fight.
    const byName = names.size === 0 ? [] : (DataCache.npcRewards || []).filter((reward) => (
        !knownIds.has(Number(reward.selfId))
        && names.has(String(reward.template?.name || '').trim().toLowerCase())
        && Array.isArray(reward.rewards) && reward.rewards.length > 0
    )).map((reward) => ({ reward, count: 1 }));
    const candidates = [...byId, ...byName];
    if (!candidates.length) return null;
    const defeatedNpcId = Number(npcSelfId || 0);
    if (defeatedNpcId > 0) {
        const exact = candidates.find((candidate) => Number(candidate.reward.selfId) === defeatedNpcId)?.reward;
        if (exact) return exact;
        const defeatedNpcName = String((DataCache.npcs || []).find((npc) => Number(npc.selfId) === defeatedNpcId)?.template?.name || '')
            .trim().toLowerCase();
        return candidates.find((candidate) => (
            defeatedNpcName && String(candidate.reward.template?.name || '').trim().toLowerCase() === defeatedNpcName
        ))?.reward || null;
    }
    let roll = rng() * candidates.reduce((sum, candidate) => sum + candidate.count, 0);
    for (const candidate of candidates) {
        roll -= candidate.count;
        if (roll <= 0) return candidate.reward;
    }
    return candidates[candidates.length - 1].reward;
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

function itemSnapshot(item, amount, sourceMobLevel = 0) {
    const template = (DataCache.items || []).find((entry) => Number(entry.selfId) === Number(item.selfId));
    if (!template || template.template?.kind === 'Other.Quest') return null;
    return {
        selfId: Number(item.selfId),
        name: item.name || template.template?.name || `Item ${item.selfId}`,
        amount,
        kind: template.template?.kind || '',
        rank: template.etc?.rank || 'none',
        sourceMobLevel: Math.max(0, Number(sourceMobLevel) || 0)
    };
}

function sourceMobLevel(rewardData, spot, npcSelfId = 0) {
    const npc = (DataCache.npcs || []).find((entry) => Number(entry.selfId) === Number(npcSelfId || rewardData?.selfId));
    return Math.max(0, Number(npc?.template?.level || spot?.avgLevel || 0));
}

function rollForFight({ spot, killerLevel, npcSelfId = 0, rng = Math.random, maxItems = 1 } = {}) {
    const rewardData = rewardDataForSpot(spot, rng, npcSelfId);
    if (!rewardData) return [];
    const defeatedNpcLevel = sourceMobLevel(rewardData, spot, npcSelfId);

    const drops = [];
    for (const group of rewardData.rewards || []) {
        if (drops.length >= maxItems) break;
        if ((group.items || []).every((item) => Number(item.selfId) === 57)) continue;

        const groupRoll = ProgressionRates.rewardGroupRoll(group, 'drop', {
            npcLevel: defeatedNpcLevel,
            killerLevel: Number(killerLevel || 0)
        }, rng);
        if (!groupRoll.hit) continue;

        const item = selectItem(group.items, rng);
        if (!item || Number(item.selfId) === 57) continue;
        const amount = ProgressionRates.scaleAmount(randInt(rng, item.min, item.max), groupRoll.amountMultiplier, rng);
        const snapshot = itemSnapshot(item, amount, defeatedNpcLevel);
        if (snapshot) drops.push(snapshot);
    }
    return drops;
}

module.exports = { rollForFight };
