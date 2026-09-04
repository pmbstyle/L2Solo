const DataCache = invoke('GameServer/DataCache');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');

const npcRewardMaxHpMultiplierCache = new Map();

function rewardDataForSpot(spot, rng, npcSelfId = 0) {
    const entries = spot?.npcEntries?.length
        ? spot.npcEntries
        : (spot?.npcSelfIds || []).map((selfId) => ({ selfId, count: 1 }));
    const byId = entries.map((entry) => ({
        reward: (DataCache.npcRewards || []).find((reward) => Number(reward.selfId) === Number(entry.selfId)),
        count: Math.max(1, Number(entry.count || 1))
    })).filter((entry) => (entry.reward?.rewards || []).length > 0 || (entry.reward?.spoils || []).length > 0);
    const knownIds = new Set(byId.map((entry) => Number(entry.reward.selfId)));
    const names = new Set((spot?.npcNames || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean));
    // World-spawn ids may not be the datapack reward ids. The spot index also
    // carries the monster names, so use that source-backed mapping before
    // giving up on loot for the fight.
    const byName = names.size === 0 ? [] : (DataCache.npcRewards || []).filter((reward) => (
        !knownIds.has(Number(reward.selfId))
        && names.has(String(reward.template?.name || '').trim().toLowerCase())
        && ((reward.rewards || []).length > 0 || (reward.spoils || []).length > 0)
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

function itemSnapshot(item, amount, sourceMobLevel = 0) {
    const template = (DataCache.items || []).find((entry) => Number(entry.selfId) === Number(item.selfId));
    if (!template || template.template?.kind === 'Other.Quest') return null;
    return {
        selfId: Number(item.selfId),
        name: item.name || template.template?.name || `Item ${item.selfId}`,
        amount,
        kind: template.template?.kind || '',
        stackable: template.etc?.stackable !== false,
        rank: template.etc?.rank || 'none',
        sourceMobLevel: Math.max(0, Number(sourceMobLevel) || 0)
    };
}

function sourceMobLevel(rewardData, spot, npcSelfId = 0) {
    const npc = (DataCache.npcs || []).find((entry) => Number(entry.selfId) === Number(npcSelfId || rewardData?.selfId));
    return Math.max(0, Number(npc?.template?.level || spot?.avgLevel || 0));
}

function rewardMaxHpMultiplier(npc) {
    const npcId = Number(npc?.selfId || 0);
    if (!npcId) return 1;
    if (npcRewardMaxHpMultiplierCache.has(npcId)) {
        return npcRewardMaxHpMultiplierCache.get(npcId);
    }

    // Background combat has templates rather than live Npc instances. Build
    // the narrow source-compatible view needed to resolve permanent NPC
    // passive skills, including Strong Type's MAX_HP multiplier.
    const npcReference = {
        fetchSelfId: () => npcId,
        fetchSummonSkillId: () => Number(npc?.summonSkillId || 0)
    };
    const multiplier = NpcSkills.maxHpMultiplierFor(npcReference);
    npcRewardMaxHpMultiplierCache.set(npcId, multiplier);
    return multiplier;
}

function progressionForFight({ spot, npcSelfId = 0, rng = Math.random } = {}) {
    const rewardData = rewardDataForSpot(spot, rng, npcSelfId);
    const npc = (DataCache.npcs || []).find((entry) => Number(entry.selfId) === Number(npcSelfId || rewardData?.selfId));
    const level = Math.max(1, Number(npc?.template?.level || spot?.avgLevel || 1));
    const expModifier = Number(npc?.rewards?.exp);
    const sp = Number(npc?.rewards?.sp);
    if (npc && Number.isFinite(expModifier) && Number.isFinite(sp)) {
        const maxHpMultiplier = rewardMaxHpMultiplier(npc);
        return {
            exact: true,
            exp: Math.max(0, level * level * expModifier * maxHpMultiplier),
            sp: Math.max(0, sp * maxHpMultiplier)
        };
    }
    return {
        exact: false,
        exp: Math.max(0, Number(spot?.rewards?.exp || 0)),
        sp: Math.max(0, Number(spot?.rewards?.sp || 0))
    };
}

function rollRewardsForFight({ spot, killerLevel, npcSelfId = 0, rng = Math.random, maxItems = Number.POSITIVE_INFINITY } = {}) {
    const rewardData = rewardDataForSpot(spot, rng, npcSelfId);
    if (!rewardData) return null;
    const defeatedNpcLevel = sourceMobLevel(rewardData, spot, npcSelfId);
    const result = { adena: 0, items: [] };
    for (const group of rewardData.rewards || []) {
        const groupRoll = ProgressionRates.rewardGroupRoll(group, 'drop', {
            npcLevel: defeatedNpcLevel,
            killerLevel: Number(killerLevel || 0)
        }, rng);
        if (!groupRoll.hit) continue;
        const item = ProgressionRates.selectDropItem(group, groupRoll.itemRate, rng);
        if (!item) continue;
        const amount = ProgressionRates.rollDropAmount(group, item, groupRoll.itemRate, rng);
        if (Number(item.selfId) === 57) {
            result.adena += amount;
        } else if (result.items.length < maxItems) {
            const snapshot = itemSnapshot(item, amount, defeatedNpcLevel);
            if (snapshot) result.items.push(snapshot);
        }
    }
    return result;
}

function rollAdenaForFight(options = {}) {
    const result = rollRewardsForFight(options);
    return result === null ? null : result.adena;
}

function rollForFight({ spot, killerLevel, npcSelfId = 0, rng = Math.random, maxItems = Number.POSITIVE_INFINITY } = {}) {
    return rollRewardsForFight({ spot, killerLevel, npcSelfId, rng, maxItems })?.items || [];
}

function rollSpoilForFight({ spot, killerLevel, npcSelfId = 0, rng = Math.random, maxItems = Number.POSITIVE_INFINITY } = {}) {
    const rewardData = rewardDataForSpot(spot, rng, npcSelfId);
    if (!rewardData) return [];
    const defeatedNpcLevel = sourceMobLevel(rewardData, spot, npcSelfId);
    const spoils = [];
    for (const group of rewardData.spoils || []) {
        if (spoils.length >= maxItems) break;
        const groupRoll = ProgressionRates.rewardGroupRoll(group, 'spoil', {
            npcLevel: defeatedNpcLevel,
            killerLevel: Number(killerLevel || 0)
        }, rng);
        if (!groupRoll.hit) continue;
        const roll = rng() * 100;
        let partition = 0;
        const item = (group.items || []).find((candidate) => {
            partition += Math.max(0, Number(candidate.chance) || 0);
            return roll <= partition;
        });
        if (!item) continue;
        const min = Math.max(1, Math.floor(Number(item.min) || 1));
        const max = Math.max(min, Math.floor(Number(item.max) || min));
        const baseAmount = min === max ? min : Math.floor(rng() * (max - min + 1)) + min;
        const amount = ProgressionRates.scaleAmount(baseAmount, groupRoll.amountMultiplier, rng);
        const snapshot = itemSnapshot(item, amount, defeatedNpcLevel);
        if (snapshot) spoils.push(snapshot);
    }
    return spoils;
}

module.exports = { progressionForFight, rollRewardsForFight, rollAdenaForFight, rollForFight, rollSpoilForFight };
