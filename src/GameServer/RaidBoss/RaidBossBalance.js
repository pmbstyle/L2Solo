const raidBossMinionDefinitions = require('../../../data/Npcs/Minions/c4_raid_bosses.json');

const RAID_ENTITY_SCALE = 0.75;
const raidBossMinionIds = new Set(
    raidBossMinionDefinitions
        .map((entry) => Number(entry?.minionId))
        .filter((id) => Number.isInteger(id) && id > 0)
);

function isRaidBossTemplate(row) {
    return row?.template?.raidBoss === true || row?.raidBoss === true;
}

function isRaidBossMinionTemplate(row) {
    return raidBossMinionIds.has(Number(row?.selfId));
}

function isRaidEntityTemplate(row) {
    return isRaidBossTemplate(row) || isRaidBossMinionTemplate(row);
}

function scaleStat(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return value;
    return Math.max(1, Math.round(numeric * RAID_ENTITY_SCALE));
}

function weakenTemplate(row) {
    if (!isRaidEntityTemplate(row)) return row;

    const next = structuredClone(row);
    next.stats = { ...(next.stats || {}) };
    next.vitals = { ...(next.vitals || {}) };

    ['pAtk', 'mAtk', 'pDef', 'mDef'].forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(next.stats, key)) {
            next.stats[key] = scaleStat(next.stats[key]);
        }
    });
    ['maxHp', 'revHp'].forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(next.vitals, key)) {
            next.vitals[key] = scaleStat(next.vitals[key]);
        }
    });

    return next;
}

function weakenTemplates(rows) {
    return Array.isArray(rows) ? rows.map(weakenTemplate) : rows;
}

module.exports = {
    RAID_ENTITY_SCALE,
    isRaidBossTemplate,
    isRaidBossMinionTemplate,
    isRaidEntityTemplate,
    weakenTemplate,
    weakenTemplates
};
