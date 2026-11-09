const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const SourceCatalog = require('../../Knowledge/SourceCatalog');

function rewardDataForSpot(spot, rng, npcSelfId = 0) {
    const defeatedNpcId = Number(npcSelfId || 0);
    const defeatedReward = defeatedNpcId > 0 ? ItemTemplateIndex.find(DataCache.npcRewards, defeatedNpcId) : null;
    // A pending fight may outlive its NPC's place in the spot catalogue.
    // Its explicitly empty drop remains authoritative even after that move.
    if (defeatedReward && !(defeatedReward.rewards || []).length && !(defeatedReward.spoils || []).length) {
        return defeatedReward;
    }
    const entries = spot?.npcEntries?.length
        ? spot.npcEntries
        : (spot?.npcSelfIds || []).map((selfId) => ({ selfId, count: 1 }));
    // An explicit empty row means zero loot, not missing source data. Keep
    // it so callers cannot replace it with name aliases or fallback Adena.
    const byId = entries.map((entry) => ({
        reward: ItemTemplateIndex.find(DataCache.npcRewards, entry.selfId),
        count: Math.max(1, Number(entry.count || 1))
    })).filter((entry) => !!entry.reward);
    const knownIds = new Set(byId.map((entry) => Number(entry.reward.selfId)));
    const names = new Set((spot?.npcNames || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean));
    // World-spawn ids may not be the datapack reward ids. The spot index also
    // carries the monster names, so use that source-backed mapping before
    // giving up on loot for the fight.
    const byName = [...names]
        .flatMap((name) => SourceCatalog.rewardRowsForName(name))
        .filter((entry) => !knownIds.has(Number(entry.reward.selfId)))
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((entry) => ({ reward: entry.reward, count: 1 }));
    const candidates = [...byId, ...byName];
    if (!candidates.length) return null;
    if (defeatedNpcId > 0) {
        const exact = candidates.find((candidate) => Number(candidate.reward.selfId) === defeatedNpcId)?.reward;
        if (exact) return exact;
        const defeatedNpcName = String(ItemTemplateIndex.find(DataCache.npcs, defeatedNpcId)?.template?.name || '')
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
    const template = ItemTemplateIndex.find(DataCache.items, item.selfId);
    if (!template || template.template?.kind === 'Other.Quest') return null;
    return {
        selfId: Number(item.selfId),
        name: item.name || template.template?.name || `Item ${item.selfId}`,
        amount,
        kind: template.template?.kind || '',
        stackable: template.etc?.stackable === true,
        rank: template.etc?.rank || 'none',
        sourceMobLevel: Math.max(0, Number(sourceMobLevel) || 0)
    };
}

// The level of a defeated NPC: its template level, else the spot average.
function npcLevel(spot, npcSelfId) {
    const npc = ItemTemplateIndex.find(DataCache.npcs, npcSelfId);
    return Math.max(0, Number(npc?.template?.level || spot?.avgLevel || 0));
}

function sourceMobLevel(rewardData, spot, npcSelfId = 0) {
    return npcLevel(spot, npcSelfId || rewardData?.selfId);
}

function progressionForFight({ spot, npcSelfId = 0, rng = Math.random } = {}) {
    const rewardData = rewardDataForSpot(spot, rng, npcSelfId);
    const npc = ItemTemplateIndex.find(DataCache.npcs, npcSelfId || rewardData?.selfId);
    const level = Math.max(1, Number(npc?.template?.level || spot?.avgLevel || 1));
    const expModifier = Number(npc?.rewards?.exp);
    const sp = Number(npc?.rewards?.sp);
    if (npc && Number.isFinite(expModifier) && Number.isFinite(sp)) {
        const maxHpMultiplier = NpcSkills.templateMaxHpMultiplierFor(npc);
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
        const context = {
            npcLevel: defeatedNpcLevel,
            killerLevel: Number(killerLevel || 0)
        };
        for (const { item, amount } of ProgressionRates.rollSpoilGroup(group, context, rng)) {
            if (spoils.length >= maxItems) break;
            const snapshot = itemSnapshot(item, amount, defeatedNpcLevel);
            if (snapshot) spoils.push(snapshot);
        }
    }
    return spoils;
}

module.exports = { npcLevel, rewardDataForSpot, progressionForFight, rollRewardsForFight, rollAdenaForFight, rollForFight, rollSpoilForFight };
