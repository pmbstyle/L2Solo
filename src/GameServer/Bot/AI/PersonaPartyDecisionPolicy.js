const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const PersonaPartyPolicy = invoke('GameServer/Bot/Population/PersonaPartyPolicy');

const ACCEPT_SCORE = 45; // Legacy diagnostic scale; admission now uses a tendency roll.

function personaFor(subject = {}) {
    return BotPersona.of(subject);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
}

function evaluate(subject, memory = {}, options = {}) {
    const persona = personaFor(subject);
    if (!persona?.traits) {
        return { accept: true, reason: 'available', reasonText: 'available', score: null, persona: null };
    }

    const trust = Number(memory.trust || 0);
    const familiarity = Number(memory.familiarity || 0);
    const relationship = BotSocialMemory.relationship(memory);
    const knownPartner = relationship === 'trusted' || relationship === 'friendly';
    // The shared persona score (PersonaPartyPolicy.baseScore) plus what the
    // bot knows of this player.
    const score = Math.round(clamp(
        PersonaPartyPolicy.baseScore(persona) +
        trust * 4 +
        familiarity * 1.5,
        0,
        100
    ));
    const Context = invoke('GameServer/Bot/Economy/EconomyContext');
    const state = subject.actor ? Context.stateForActor(subject.actor, subject) : subject;
    const peer = options.peer?.actor ? Context.stateForActor(options.peer.actor, options.peer) : options.peer;
    const decision = peer ? require('../Population/PartyGoalPolicy').decide(state, [peer], { persona,
        fee: options.fee || 0, roll: require('./TendencyRoll').roll('party_invite', state.characterId,
            peer.characterId, memory.updatedAt || memory.lastInteractionAt || 0) }) : null;
    const accept = decision ? decision.accept : require('./TendencyRoll').roll('party_invite', state.characterId,
        memory.updatedAt || 0) < require('./TendencyRoll').chance(score / 100 + (knownPartner ? persona.traits.commitment / 4 : 0));
    const goal = require('../Population/PartyGoalPolicy').declaration(state);

    if (accept) {
        return {
            accept: true,
            reason: 'available',
            reasonText: 'available',
            score,
            persona, goal
        };
    }

    return {
        accept: false,
        reason: 'prefers_solo',
        reasonText: 'prefers a solo run for now',
        score,
        persona, goal
    };
}

function reply(decision) {
    if (!decision?.accept) {
        return 'I am keeping this run focused for now. Let us get to know each other first.';
    }
    const goal = decision.goal?.itemId ? ` I am working toward item ${decision.goal.itemId}.`
        : decision.goal?.spotId ? ` My next goal is ${decision.goal.spotId}.` : '';
    if (goal) return `I am in.${goal} Let us agree on the loot before we start.`;
    if (decision.persona?.primaryDrive === 'social') return 'Gladly. A steady party is better than going alone.';
    if (decision.persona?.primaryDrive === 'wealth') return 'I can make time for a familiar partner. Let us make the run count.';
    return 'A good party will help the next run. I am in.';
}

module.exports = { ACCEPT_SCORE, evaluate, reply };
