'use strict';
// C4 PvP rules (Lisvus L2PcInstance.updatePvPStatus / onKillUpdatePvPKarma,
// PcStatus.reduceHp): who gets the PvP flag, what a kill does to the killer's
// PvP/PK counts and karma, and when CP takes damage. Pure; hot
// (PvpFlag.attack, ReceivedHit) and cold (ColdPvpResolver, the cold commit in
// Database) call it.
const Karma = require('./Karma');

// Ours, not C4: Lisvus ships PvPVsNormalTime 40 s and PvPVsPvPTime 20 s.
const FLAG_MS = 15000;

// A playable is a character or its summon or pet; servitors and pets are Npc
// objects with an owner, a quest monster with an owner is not one.
function isPlayable(creature) {
    if (!creature) return false;
    if (typeof creature.fetchKind !== 'function') return true;
    return creature.fetchIsSummon?.() === true || creature.fetchIsPet?.() === true
        || ['Summon', 'Pet'].includes(creature.fetchKind());
}

// Attacking a character (or its summon or pet) flags the attacker only when
// that character has no karma: hunting a PK is free. A summon's attack flags
// its owner; the caller passes the owner's target's karma.
function flagsAttacker(targetKarma) {
    return !(Number(targetKarma) > 0);
}

// The killer's tally change: 'pvp' (PvP +1), 'pk' (PK +1 and karma), 'karma'
// (karma only: a white character's summon or pet) or 'none'.
// - a flagged victim killed by a killer without karma: PvP (a flagged summon: nothing);
// - a mutual clan war: PvP;
// - a victim with karma: PvP (Lisvus AwardPKKillPVPPoint = True);
// - a white unflagged victim: PK and karma, its summon or pet karma only;
// - a flagged victim killed by a killer with karma: nothing.
const KILL_OUTCOMES = ['pvp', 'pk', 'karma', 'none'];
function killOutcome({ killerKarma, victimKarma, victimFlagged, mutualWar = false, victimIsPlayer = true }) {
    const killerWhite = !(Number(killerKarma) > 0), victimWhite = !(Number(victimKarma) > 0);
    const player = outcome => victimIsPlayer ? outcome : 'none';
    if (killerWhite && victimWhite && victimFlagged) return player('pvp');
    if (mutualWar) return player('pvp');
    if (!victimWhite) return player('pvp');
    if (!victimFlagged) return victimIsPlayer ? 'pk' : 'karma';
    return 'none';
}

// killer: { pvp, pk, karma, level } before the kill; victimLevel is the
// victim character's (a summon's owner's) level. Karma reads the PK count
// before this kill.
function tallyAfterKill(killer, outcome, victimLevel) {
    const pvp = Number(killer.pvp) || 0, pk = Number(killer.pk) || 0, karma = Number(killer.karma) || 0;
    const award = outcome === 'pk' || outcome === 'karma'
        ? Karma.pkKillKarma({ fetchPk: () => pk, fetchLevel: () => killer.level }, { fetchLevel: () => victimLevel })
        : 0;
    return { pvp: pvp + Number(outcome === 'pvp'), pk: pk + Number(outcome === 'pk'), karma: karma + award };
}

// After Transfer Pain, CP takes a playable attacker's damage first, then HP
// takes the rest; a monster's damage goes to HP.
function shieldDamage(cp, damage, attackerPlayable) {
    const current = Math.max(0, Number(cp) || 0), incoming = Math.max(0, Number(damage) || 0);
    const absorbed = attackerPlayable ? Math.min(current, incoming) : 0;
    return { cp: current - absorbed, hp: incoming - absorbed };
}

module.exports = { FLAG_MS, KILL_OUTCOMES, isPlayable, flagsAttacker, killOutcome, tallyAfterKill, shieldDamage };
