const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');

function summonNpcStats(profile, details) {
    const direct = ItemTemplateIndex.find(DataCache.npcs, details.npcId);
    const skill = (DataCache.skills || []).find((entry) => Number(entry.selfId) === Number(details.skillId));
    const skillLevel = Number(details.skillLevel || 1);
    const levelCandidates = (skill?.levels || [])
        .map((level) => ({
            level: Number(level.level) || 0,
            npc: ItemTemplateIndex.find(DataCache.npcs, level.npcId)
        }))
        .filter((entry) => entry.npc)
        .sort((a, b) => Math.abs(a.level - skillLevel) - Math.abs(b.level - skillLevel));
    const summonName = String(skill?.template?.name || skill?.name || '').toLowerCase();
    const fallbackIds = summonName.includes('soulless') || summonName.includes('reanimated')
        || summonName.includes('corrupted') || summonName.includes('cursed man')
        ? [12070, 12366, 12071, 12367]
        : [];
    const familyFallback = fallbackIds
        .map((id) => ItemTemplateIndex.find(DataCache.npcs, id))
        .find(Boolean);
    const npc = direct || levelCandidates[0]?.npc || familyFallback;
    return {
        npcId: Number(details.npcId || 0),
        maxHp: Math.max(1, Number(npc?.vitals?.maxHp || profile.maxHp * 1.15)),
        pAtk: Math.max(1, Number(npc?.stats?.pAtk || profile.pAtk * 0.85)),
        pAtkRnd: Math.max(0, Number(npc?.stats?.pAtkRnd || profile.equipment?.pAtkRnd || 0)),
        pDef: Math.max(1, Number(npc?.stats?.pDef || profile.pDef * 0.8)),
        accur: Math.max(1, Number(npc?.stats?.accur || profile.accur)),
        critical: Math.max(0, Number(npc?.stats?.crit || profile.critical)),
        atkSpd: Math.max(1, Number(npc?.stats?.atkSpd || profile.atkSpd))
    };
}

module.exports = summonNpcStats;
