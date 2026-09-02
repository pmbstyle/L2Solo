const DANGEROUS_SOLO_TAGS = new Set(['catacomb', 'party_required']);
const GRADE_RANKS = ['none', 'd', 'c', 'b', 'a', 's'];

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function gradeRank(value) {
    const rank = GRADE_RANKS.indexOf(String(value || 'none').toLowerCase());
    return rank < 0 ? 0 : rank;
}

function expectedGradeRank(level) {
    const value = number(level, 1);
    if (value >= 76) return 5;
    if (value >= 61) return 4;
    if (value >= 52) return 3;
    if (value >= 40) return 2;
    if (value >= 20) return 1;
    return 0;
}

function equipmentRows(state = {}, options = {}) {
    if (Array.isArray(options.equipment)) return options.equipment;
    // The compact cold projection stores equipped slots only, so it does not
    // repeat an `equipped` flag on every row.
    if (Array.isArray(state.stats?.equipment)) {
        return state.stats.equipment.map((item) => ({ equipped: true, ...item }));
    }
    if (Array.isArray(state.equipment)) return state.equipment;
    const inventory = state.inventory;
    return Array.isArray(inventory) ? inventory : Object.values(inventory || {});
}

function normalizeEquipment(row = {}) {
    const item = row || {};
    const equipped = typeof item.fetchEquipped === 'function'
        ? item.fetchEquipped() === true
        : item.equipped === true || number(item.equippedCount) > 0 || (item.equippedSlots || []).length > 0;
    const kind = typeof item.fetchKind === 'function' ? item.fetchKind() : item.kind || item.template?.kind || '';
    const rank = typeof item.fetchRank === 'function' ? item.fetchRank() : item.rank || item.etc?.rank || 'none';
    const slot = typeof item.fetchSlot === 'function' ? item.fetchSlot() : item.slot || item.etc?.slot || 0;
    return { equipped, kind: String(kind || ''), rank: gradeRank(rank), slot: number(slot) };
}

function isWeapon(item) {
    return item.kind.startsWith('Weapon.') || item.slot === 7 || item.slot === 14;
}

function isArmor(item) {
    return [6, 8, 9, 10, 11, 12, 15].includes(item.slot);
}

function identityFor(spot = {}) {
    return [spot.id, spot.name, spot.area?.id, spot.area?.name]
        .filter(Boolean)
        .join(' ');
}

function zoneSoloGrade(identity = '') {
    if (/\bcruma(?: tower)?\b/i.test(identity)) return gradeRank('c');
    if (/\btower of insolence\b/i.test(identity)) return gradeRank('b');
    if (/\b(?:antharas(?:'s|')? lair|lair of antharas)\b/i.test(identity)) return gradeRank('a');
    return null;
}

function hasExceptionalSoloReadiness(spot = {}, state = {}, options = {}) {
    const level = Math.max(1, number(options.level ?? state.level, 1));
    const maxLevel = Math.max(1, number(spot.maxLevel ?? spot.avgLevel ?? spot.minLevel, level));
    const equipped = equipmentRows(state, options).map(normalizeEquipment).filter((item) => item.equipped);
    const tags = tagsFor(spot, options).map((tag) => String(tag));
    const identity = identityFor(spot);
    const configuredGrade = zoneSoloGrade(identity);
    const deepParty = tags.includes('catacomb') || tags.includes('deep_party')
        || /\b(catacomb|necropolis|tower of insolence|antharas(?:'s|')? lair|lair of antharas)\b/i.test(identity);
    // These three progression zones have explicit solo entry kits. The normal
    // level-fit and target-power filters still decide which floor and mob are
    // appropriate; this gate only prevents under-equipped solo entry.
    let equipmentGrade = configuredGrade;
    if (configuredGrade !== null) {
        const minimumLevel = Math.max(1, number(spot.minLevel ?? spot.avgLevel, level));
        if (level < minimumLevel) return false;
    } else {
        // Seven Signs rooms remain the stricter fallback observed in live
        // results: six levels over the spot and a complete S-grade kit.
        if (level < maxLevel + 6) return false;
        const minimumGrade = deepParty ? gradeRank('s') : expectedGradeRank(maxLevel) + 1;
        equipmentGrade = expectedGradeRank(level);
        if (equipmentGrade < minimumGrade || equipmentGrade <= expectedGradeRank(maxLevel)) return false;
    }
    const weapon = equipped.find(isWeapon);
    const armor = equipped.filter(isArmor);
    return Boolean(weapon && weapon.rank >= equipmentGrade && armor.length >= 4
        && armor.filter((item) => item.rank >= equipmentGrade).length >= 4);
}

function tagsFor(spot = {}, options = {}) {
    if (Array.isArray(options.tags)) return options.tags;
    return Array.isArray(spot.tags) ? spot.tags : [];
}

function isDangerousSoloGround(spot = {}, options = {}) {
    if (tagsFor(spot, options).some((tag) => DANGEROUS_SOLO_TAGS.has(String(tag)))) return true;
    // Older persisted/current spot projections may predate canonical tags.
    // The names and area ids remain stable, so keep the hard safety gate
    // effective while those bots are being routed out after a restart.
    const identity = identityFor(spot);
    return /\b(catacomb|necropolis|cruma(?: tower)?|tower of insolence|antharas(?:'s|')? lair|lair of antharas)\b/i.test(identity);
}

function isParty(state = {}, options = {}) {
    const mode = String(options.mode || state.stats?.routeMode || '').toLowerCase();
    return options.party === true || ['duo', 'party'].includes(mode)
        || Boolean(state.party?.partyId || state.partyId)
        || state.activity === 'grouped';
}

function evaluate(spot = {}, state = {}, options = {}) {
    const requiresParty = isDangerousSoloGround(spot, options);
    const grouped = isParty(state, options);
    const exceptionalSoloReady = requiresParty && !grouped
        ? hasExceptionalSoloReadiness(spot, state, options)
        : false;
    const allowed = !requiresParty || grouped || exceptionalSoloReady;
    return {
        allowed,
        requiresParty,
        grouped,
        exceptionalSoloReady,
        reason: allowed
            ? (exceptionalSoloReady ? 'exceptional_solo_readiness' : (grouped ? 'party_ready' : 'ordinary_hunting_ground'))
            : 'party_required_hunting_ground'
    };
}

module.exports = {
    DANGEROUS_SOLO_TAGS,
    evaluate,
    hasExceptionalSoloReadiness,
    isDangerousSoloGround,
    isParty
};
