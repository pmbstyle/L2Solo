'use strict';
// Owner: whether an NPC is undead (T121). The datapack marks it by race
// ('undead', 296 NPCs; L2J Creature.isUndead = race UNDEAD), never by a flag,
// so undead-only skills (Might of Heaven, Disrupt Undead, Holy Strike) and the
// P.Atk-vs-undead bonus read this. Takes the npc row's traits or a flattened model.
// Pure: the cold worker loads it without the live world.
function isUndead(traits = {}) {
    return traits?.undead === true || String(traits?.race || '').toLowerCase() === 'undead';
}

module.exports = { isUndead };
