'use strict';

const data = require('../../../data/RaidBoss/c4_grand_bosses.json');
const ids = new Set(data.epicDrops.map(row => row.npcId));
const minionIds = new Set(data.minions.map(row => row.minionId));
function templateId(value) {
    return Number(value?.fetchSelfId?.() ?? value?.raidBossTemplateId ?? value?.npcId
        ?? value?.selfId ?? value?.model?.selfId ?? value);
}
const isGrandBoss = value => ids.has(templateId(value));
const isEncounterNpc = value => isGrandBoss(value) || minionIds.has(templateId(value));
const maxLevel = (source, ordinaryMaximum) => isGrandBoss(source) ? 78 : ordinaryMaximum;
const isPassive = value => templateId(value) === 12002;

function respawnDelayMs(value, random = Math.random) {
    const hours = data.respawnHours[templateId(value)];
    if (!hours) return null;
    // Lisvus draws an inclusive integer number of hours with Rnd.get(-n, n).
    const roll = Math.max(0, Math.min(.999999999, random()));
    return (hours[0] - hours[1] + Math.floor(roll * (hours[1] * 2 + 1))) * 3600000;
}

// Grand bosses are raids for ownership, loot and safety, but Lisvus constructs
// them with setIsRaid(true, false): no Raid Curse caster flag.
module.exports = { data, templateId, isGrandBoss, isEncounterNpc, isPassive, maxLevel, respawnDelayMs };
