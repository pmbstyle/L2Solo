const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const PartyAffinity = invoke('GameServer/Bot/Population/BackgroundPartyAffinity');

function supportCount(coverage = {}) {
    return ['tank', 'healer', 'buffer'].filter((role) => Number(coverage[role] || 0) > 0).length;
}

function profileFor(state) {
    return BotPersona.of(state);
}

// How much a persona wants a party, before the situation: shared by the
// bot-to-bot intent below and the answer to a player's invite
// (PersonaPartyDecisionPolicy). Not rounded.
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

    const establishedBond = Object.values(state.stats?.partyHistory || {})
        .some((entry) => Number(entry?.runs || 0) >= 3);
    const score = Math.round(baseScore(persona));
    const accept = establishedBond || score >= 45;
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

function explain(state, peers = [], coverage = {}) {
    const result = preference(state, peers, coverage);
    const intent = backgroundIntent(state);
    const memoryScore = require('./PartyMemoryPreference').create().score(state, peers);
    const memoryReason = memoryScore > 0 ? 'positive_interactions' : memoryScore < 0 ? 'personal_conflict' : null;
    return {
        score: result.score,
        memoryScore,
        reasons: [...(memoryReason ? [memoryReason] : []), ...result.reasons].slice(0, 3),
        primaryDrive: result.persona?.primaryDrive || null,
        archetype: result.persona?.archetype || null,
        partyIntent: intent.reason
    };
}

module.exports = { baseScore, backgroundIntent, preference, explain };
