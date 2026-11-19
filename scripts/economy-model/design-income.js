'use strict';

// The design's drop rule at a spot, the economy model's design yields: the
// game's deep-blue penalty and spoil landing are the rule's arguments. The
// spots hold normal NPCs only (the snapshot's compositions leave raid bosses,
// epics and their minions out), so every NPC rolls at the normal rates.

const { dropRule } = require('./rules/dropRule');

const SPOIL_SKILL = 254;

// The game's deep-blue penalty and spoil landing, the drop rule's arguments.
// Needs Boot.boot().
function gameRules() {
    const Rates = invoke('GameServer/ProgressionRates'), Formulas = invoke('GameServer/Formulas');
    const landed = new Map();
    return {
        penalty: (npcLevel, killerLevel) => Rates.deepBlueRule({ npcLevel, killerLevel }),
        landed: (skillLevel, attackerLevel, targetLevel) => {
            const key = `${skillLevel}:${attackerLevel}:${targetLevel}`;
            if (!landed.has(key)) landed.set(key, Formulas.spoilSuccessChance({ skillId: SPOIL_SKILL, skillLevel, attackerLevel, targetLevel }));
            return landed.get(key);
        }
    };
}

// Expected items per kill at a spot under the design rule: { drop, spoil }
// item -> count, the spot's spawns weighted by count, spoils with Spoil
// landed at the spoiler's skill level (0: none).
function designYields(snapshot, spotId, level, spoilSkill, rates, game) {
    const spot = snapshot.compositions[spotId], drop = {}, spoil = {};
    if (!spot) return null;
    const npcs = spot.npcs.filter(npc => npc.rewardId !== null && snapshot.rewards[npc.rewardId]);
    const total = npcs.reduce((sum, npc) => sum + npc.count, 0);
    for (const npc of npcs) {
        const reward = snapshot.rewards[npc.rewardId], share = npc.count / total, penalty = game.penalty(npc.level, level);
        for (const group of reward.rewards) {
            for (const [id, count] of Object.entries(dropRule({ group, kind: 'drop', rates, penalty }))) drop[id] = (drop[id] || 0) + share * count;
        }
        if (!(spoilSkill > 0)) continue;
        const landed = game.landed(spoilSkill, level, npc.level);
        for (const group of reward.spoils) {
            for (const [id, count] of Object.entries(dropRule({ group, kind: 'spoil', rates, penalty }))) spoil[id] = (spoil[id] || 0) + share * count * landed;
        }
    }
    return { drop, spoil };
}

module.exports = { designYields, gameRules };
