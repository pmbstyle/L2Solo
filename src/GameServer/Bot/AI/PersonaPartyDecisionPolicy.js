const BotPersona = invoke('GameServer/Bot/AI/BotPersona');

const ACCEPT_SCORE = 45;

function personaFor(subject = {}) {
    if (subject?.persona?.traits) return subject.persona;
    const characterId = Number(subject?.characterId || subject?.id || subject?.actor?.fetchId?.() || 0);
    return BotPersona.generate({ ...subject, characterId });
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
}

function evaluate(subject, memory = {}) {
    const persona = personaFor(subject);
    if (!persona?.traits) {
        return { accept: true, reason: 'available', reasonText: 'available', score: null, persona: null };
    }

    const traits = persona.traits;
    const trust = Number(memory.trust || 0);
    const familiarity = Number(memory.familiarity || 0);
    const knownPartner = trust >= 3 || familiarity >= 5;
    const driveBonus = persona.primaryDrive === 'social' ? 18
        : persona.primaryDrive === 'progression' ? 6 : -12;
    const score = Math.round(clamp(
        traits.sociability * 60 +
        traits.empathy * 10 +
        traits.commitment * 10 +
        driveBonus +
        trust * 4 +
        familiarity * 1.5,
        0,
        100
    ));
    const accept = knownPartner || score >= ACCEPT_SCORE;

    if (accept) {
        return {
            accept: true,
            reason: 'available',
            reasonText: 'available',
            score,
            persona
        };
    }

    return {
        accept: false,
        reason: 'prefers_solo',
        reasonText: 'prefers a solo run for now',
        score,
        persona
    };
}

function reply(decision) {
    if (!decision?.accept) {
        return 'I am keeping this run focused for now. Let us get to know each other first.';
    }
    if (decision.persona?.primaryDrive === 'social') return 'Gladly. A steady party is better than going alone.';
    if (decision.persona?.primaryDrive === 'wealth') return 'I can make time for a familiar partner. Let us make the run count.';
    return 'A good party will help the next run. I am in.';
}

module.exports = { ACCEPT_SCORE, evaluate, reply };
