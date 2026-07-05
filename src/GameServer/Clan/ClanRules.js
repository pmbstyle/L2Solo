const CP_CL_JOIN_CLAN = 1;
const CP_CL_GIVE_TITLE = 2;
const CP_CL_VIEW_WAREHOUSE = 4;
const CP_CL_MANAGE_CREST = 8;
const CP_CL_CLAN_WAR = 1024;
const CP_ALL = 2047;

const LEVEL_REQUIREMENTS = {
    0: { nextLevel: 1, sp: 30000, adena: 650000 },
    1: { nextLevel: 2, sp: 150000, adena: 2500000 },
    2: { nextLevel: 3, sp: 500000, itemId: 1419, itemName: 'Proof of Blood' },
    3: { nextLevel: 4, sp: 1400000, itemId: 3874, itemName: 'Proof of Alliance' },
    4: { nextLevel: 5, sp: 3500000, itemId: 3870, itemName: 'Proof of Aspiration' }
};

function memberLimit(level) {
    if (level <= 0) return 10;
    if (level === 1) return 15;
    if (level === 2) return 20;
    if (level === 3) return 30;
    return 40;
}

function normalizeName(name) {
    return String(name || '').trim();
}

function validateClanName(name) {
    const value = normalizeName(name);
    if (value.length < 2) return { ok: false, code: 'name_too_short' };
    if (value.length > 16) return { ok: false, code: 'name_too_long' };
    if (!/^[A-Za-z0-9]+$/.test(value)) return { ok: false, code: 'name_invalid' };
    return { ok: true, name: value };
}

function hasPrivilege(actor, privilege) {
    return (Number(actor?.fetchClanPrivileges?.() || 0) & privilege) === privilege;
}

module.exports = {
    CP_CL_JOIN_CLAN,
    CP_CL_GIVE_TITLE,
    CP_CL_VIEW_WAREHOUSE,
    CP_CL_MANAGE_CREST,
    CP_CL_CLAN_WAR,
    CP_ALL,
    LEVEL_REQUIREMENTS,
    memberLimit,
    normalizeName,
    validateClanName,
    hasPrivilege
};
