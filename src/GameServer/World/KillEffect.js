'use strict';

// One consequence of a death, an NPC's (Npc/Generics/Die, NpcDied, RemoveNpc's drops) or a
// character's (Actor/Generics/Die): a reward, a quest callback, a raid's minions, a guardian spawn,
// a PK drop, the death's EXP loss, a bot's life row or journal line. The death itself (dead state,
// effects cleared, the die packet, the corpse's decay and respawn) is not one. A consequence that
// throws is counted under its site (`kill.<what>` for an NPC, `death.<what>` for a character:
// FailureLog logs its first stack and writes a trace failure record) and the others still run; a
// death comes from a hit timer, where a throw would exit the server. C4 (Lisvus
// L2Attackable.doDie, calculateRewards): a failed reward or quest notification is logged and the
// death goes on. The character side is our choice by extension of that NPC rule.
const FailureLog = require('../../FailureLog');

function killEffect(site, effect) {
    try { effect(); } catch (error) { FailureLog.note(site, error); }
}

module.exports = { killEffect };
