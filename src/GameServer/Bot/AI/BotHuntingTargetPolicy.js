const SIEGE_CLAN = /\bsiege\b/i;
const CASTLE_ROYAL_GATEKEEPER = /^(?:Gludio|Dion|Giran|Oren|Aden) Royal Gatekeeper$/i;

function npcName(npc) {
    if (!npc) return '';
    if (typeof npc.fetchName === 'function') return String(npc.fetchName() || '');
    return String(npc.name || npc.template?.name || npc.model?.name || npc.model?.template?.name || '');
}

function clanName(npc) {
    if (!npc) return '';
    if (typeof npc.fetchClanName === 'function') return String(npc.fetchClanName() || '');
    return String(
        npc.clanName ||
        npc.clan?.clanName ||
        npc.model?.clanName ||
        npc.model?.clan?.clanName ||
        ''
    );
}

function isSiegeGuard(npc) {
    return SIEGE_CLAN.test(clanName(npc));
}

function isCastleUtility(npc) {
    return CASTLE_ROYAL_GATEKEEPER.test(npcName(npc));
}

function canHunt(npc) {
    return !!npc && !isSiegeGuard(npc) && !isCastleUtility(npc);
}

module.exports = { npcName, clanName, isSiegeGuard, isCastleUtility, canHunt };
