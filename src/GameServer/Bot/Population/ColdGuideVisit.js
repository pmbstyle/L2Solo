'use strict';

// A far bot's Newbie Guide visit: the executor of its rebuff answered the guide
// (Bot/AI/Rebuff), the round of its worker step (ColdSimulationKernel guideRound;
// pure, on the background thread). The guide in reach gives its blessing
// (BotBuffs.newbieEffects: its three 20-minute buffs) and no HP/MP, as it does a
// body (applyFullNewbieBlessing; C4: L2J Lisvus's newbie helper casts its buffs and
// restores nothing). A bot in the field walks to the guide and back: that time it
// rests (no fights) at the walking pace a far bot's town walk uses (ColdVisit). Done
// once, buffed or not (its level or karma moved since the answer, the guide is out
// of reach, or the bot died in the round: a dead bot walks to no guide, and its
// restart's field step reads its buffs anew, Situations.buffFact); a refusal is
// counted rebuff:guide:<why>.
const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');
const Rebuff = invoke('GameServer/Bot/AI/Rebuff');
const WALK_UNITS_PER_SECOND = 120;
const FIELD = new Set(['hunting', 'resting']);

function pending(state) {
    return Rebuff.pending(state?.stats, 'guide');
}

// The step's round (its result, as resolveSolo's: BotLifeState.prepareResolve).
function plan(state, timestamp) {
    const answer = pending(state), stats = state.stats || {};
    const guide = BotBuffs.closestGuide(state.loc);
    const refused = state.activity === 'dead' || Number(state.vitals?.hp) <= 0 ? 'dead'
        : !BotBuffs.newbieEligible(state.level, stats.karma) ? 'outgrown' : !BotBuffs.guideInReach(state.loc, guide) ? 'away' : null;
    if (refused) invoke('GameServer/Bot/Situations').note(`rebuff:guide:${refused}`);
    const serves = !refused;
    const field = FIELD.has(state.activity);
    const walkMs = serves && field ? Math.ceil(2 * Math.hypot(Number(state.loc?.locX || 0) - guide.locX,
        Number(state.loc?.locY || 0) - guide.locY) / WALK_UNITS_PER_SECOND) * 1000 : 0;
    const blessing = serves ? BotBuffs.newbieEffects(timestamp) : [];
    const keys = new Set(blessing.map(effect => effect.key));
    const patch = { stats: { ...stats, rebuff: Rebuff.done(answer) } };
    if (serves) {
        patch.stats.coldCombat = { ...stats.coldCombat,
            effects: [...(stats.coldCombat?.effects || []).filter(effect => !keys.has(effect.key)), ...blessing] };
    }
    if (walkMs > 0) {
        patch.activity = 'resting';
        patch.stats.restUntil = timestamp + walkMs;
    }
    return { patch, events: serves ? [{ type: 'newbie_guide', weight: 1,
        summary: `${state.name || 'Bot'} received the Newbie Guide's blessing in ${guide.name}` }] : [],
    materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp + Math.max(1000, walkMs),
    debug: { activity: serves ? 'newbie_guide' : `newbie_guide_${refused}`, fights: 0, wins: 0 } };
}

module.exports = { pending, plan };
