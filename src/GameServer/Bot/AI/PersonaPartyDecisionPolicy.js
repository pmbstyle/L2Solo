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
    const knownPartner = (relationship === 'trusted' || relationship === 'friendly') && Number(memory.groupRuns || 0) >= 1;
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
    const roll = require('./TendencyRoll').roll('party_invite', state.characterId,
        peer?.characterId || memory.playerId || 0, Number(memory.inviteAttempts || 0));
    const bonus = knownPartner ? persona.traits.commitment / 4 : 0;
    const decision = peer ? require('../Population/PartyGoalPolicy').decide(state, [peer], { persona,
        fee: options.fee || 0, roll, bonus }) : null;
    const probability = decision?.probability ?? require('./TendencyRoll').chance(score / 100 + bonus);
    const accept = roll < probability;
    const goal = require('../Population/PartyGoalPolicy').declaration(state);

    if (accept) {
        return {
            accept: true,
            reason: 'available',
            reasonText: 'available',
            score,
            persona, goal, probability, roll
        };
    }

    return {
        accept: false,
        reason: 'prefers_solo',
        reasonText: 'prefers a solo run for now',
        score,
        persona, goal, probability, roll
    };
}

function reply(decision) {
    if (!decision?.accept) {
        return 'I am keeping this run focused for now. Let us get to know each other first.';
    }
    const goal = require('../Population/PartyAgreement').describe(decision.goal, null);
    if (goal) return `ok, ${goal}`;
    if (decision.persona?.primaryDrive === 'social') return 'Gladly. A steady party is better than going alone.';
    if (decision.persona?.primaryDrive === 'wealth') return 'I can make time for a familiar partner. Let us make the run count.';
    return 'A good party will help the next run. I am in.';
}

module.exports = { ACCEPT_SCORE, evaluate, reply };
