const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const PartyAffinity = invoke('GameServer/Bot/Population/BackgroundPartyAffinity');
const TendencyRoll = require('../AI/TendencyRoll');
const PartyRequestPlanner = require('./PartyRequestPlanner');

function supportCount(coverage = {}) {
    return ['tank', 'healer', 'buffer'].filter((role) => Number(coverage[role] || 0) > 0).length;
}

function profileFor(state) {
    return BotPersona.of(state);
}

// How much a persona wants a party, before the situation (the bot-to-bot
// intent below). Not rounded.
function baseScore(persona) {
    const traits = persona.traits;
    const driveBonus = persona.primaryDrive === 'social' ? 18
        : persona.primaryDrive === 'progression' ? 4 : -8;
    return traits.sociability * 55 + traits.commitment * 25 + traits.empathy * 10 + driveBonus;
}

function backgroundIntent(state = {}) {
    const persona = profileFor(state);
    if (!persona) return { accept: true, reason: 'no_persona', score: null, persona: null };
    if (state.activity === 'party_wait' || state.stats?.partyRequest?.priority === 'required') {
        return { accept: true, reason: 'goal_requires_party', score: 100, persona };
    }
    // A healer or buffer without solo ground seeks a party whatever its
    // persona (decision 10-30, T106); the persona still weighs each party it
    // is offered (PartyGoalPolicy.decide) and its score stays its own.
    if (PartyRequestPlanner.seeksParty(state)) {
        return { accept: true, reason: 'no_solo_ground', score: Math.round(baseScore(persona)), persona };
    }
    // A bot that asked for a party because its share there beats its solo hunt.
    if (PartyRequestPlanner.seeksIncome(state)) {
        return { accept: true, reason: PartyRequestPlanner.PARTY_INCOME, score: Math.round(baseScore(persona)), persona };
    }

    const establishedBond = Object.values(state.stats?.partyHistory || {})
        .some((entry) => Number(entry?.runs || 0) >= 3);
    const score = Math.round(baseScore(persona));
    const probability = TendencyRoll.chance(score / 100 + (establishedBond ? persona.traits.commitment / 4 : 0));
    const accept = TendencyRoll.roll('party_intent', state.characterId,
        state.stats?.partyRequest?.requestedAt || state.spotId || state.updatedAt) < probability;
    return {
        accept,
        reason: establishedBond ? 'established_party_bonds'
            : accept ? 'open_to_party' : 'prefers_solo',
        score,
        persona
    };
}

function preference(state, peers = [], coverage = {}) {
    const persona = profileFor(state);
    if (!persona) return { score: 0, reasons: [] };

    const traits = persona.traits;
    const familiarity = PartyAffinity.affinity(state, peers);
    const supports = supportCount(coverage);
    const score = Math.round(
        traits.sociability * 40 +
        traits.ambition * 12 +
        traits.empathy * 8 +
        familiarity * (10 + traits.commitment * 10) +
        traits.caution * supports * 5
    );
    const reasons = [];
    if (familiarity > 0 && traits.commitment >= 0.5) reasons.push('familiar_party');
    if (traits.sociability >= 0.65) reasons.push('social');
    if (traits.caution >= 0.65 && supports > 0) reasons.push('safe_composition');
    if (traits.ambition >= 0.7) reasons.push('progress_focus');
    return { score, reasons: reasons.slice(0, 3), persona };
}

module.exports = { baseScore, backgroundIntent, preference };
