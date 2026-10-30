'use strict';
// Owner: how far an aggressive NPC sees a target (T114): its C4 aggro range
// (L2J Lisvus npc.sql `aggro`, data/Npcs/aggro-ranges.json from
// scripts/generate-npc-aggro-ranges.js), else the author's 500. Read by the
// live aggro (NpcAggro) and the pull estimate (BotPullEstimate).
// Pure: the cold worker loads it without the live world.
const RANGES = require('../../../data/Npcs/aggro-ranges.json').ranges;
const DEFAULT_RANGE = 500;
const MAX_RANGE = Math.max(DEFAULT_RANGE, ...Object.values(RANGES));

function of(selfId, fallback = DEFAULT_RANGE) {
    return RANGES[selfId] ?? fallback;
}

module.exports = { of, DEFAULT_RANGE, MAX_RANGE };
