const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const PartyAffinity = invoke('GameServer/Bot/Population/BackgroundPartyAffinity');

function supportCount(coverage = {}) {
    return ['tank', 'healer', 'buffer'].filter((role) => Number(coverage[role] || 0) > 0).length;
}

function profileFor(state) {
    return BotPersona.generate(state);
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
    return {
        score: result.score,
        reasons: result.reasons,
        primaryDrive: result.persona?.primaryDrive || null,
        archetype: result.persona?.archetype || null
    };
}

module.exports = { preference, explain };
