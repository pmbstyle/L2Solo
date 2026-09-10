const Policy = require('../../Social/ResourceCompetitionPolicy');
const WAIT_MS = 15000, COOLDOWN_MS = 120000;
const report = { decisions: {}, yields: 0, avoids: 0, parties: 0, recruits: 0, rejected: 0, recent: [] };
const id = s => Number(s?.actor?.fetchId?.() || 0);
const loc = a => ({ locX: a.fetchLocX(), locY: a.fetchLocY(), locZ: a.fetchLocZ() });
const autonomous = s => !!s?.actor && String(s.accountId || '').startsWith('bot_')
    && !s.partyCompanion && !s.followPlayerSession && !s.staticService && !s.arenaEphemeral;
const memory = () => invoke('GameServer/Social/InteractionMemoryRuntime');
const threats = () => invoke('GameServer/Bot/AI/BotPvpThreats');

function side(session) {
    if (!autonomous(session)) return null;
    const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
    const party = session.hotBackgroundPartyId ? Parties.find(session.hotBackgroundPartyId) : null;
    const sessions = party ? invoke('GameServer/Bot/AI/HotBackgroundParty').roster(session) : [session];
    if (session.hotBackgroundPartyId && (party?.status !== 'hot' || sessions.length !== party.memberIds.length
        || sessions.length < 2 || !sessions.some(s => id(s) === party.leaderId))
        || !party && session.coldLifeState?.party?.partyId
        || sessions.length > 9 || new Set(sessions.map(id)).size !== sessions.length) return null;
    const owner = sessions.find(s => id(s) === party?.leaderId) || session;
    return { party, sessions, owner, principal: session,
        signature: JSON.stringify([party?.partyId || null, party?.updatedAt || 0, sessions.map(id).sort((a, b) => a - b)]) };
}

function available(s) {
    return autonomous(s) && s.aiActive !== false && !s.populationStaging && s.plan === 'hunting'
        && threats().alive(s.actor) && s.actor.fetchHp() > 0
        && !s.pvpDefense && !s.pvpRevenge && !s.pendingPvpProvocation && !s.pvpEncounter
        && !s.trade && !s.activeTrade && !s.activeNegotiation && !s.pendingPartyInvite && !s.clanAllianceQuest
        && !s.spotRelocation && !s.supplyErrandPhase
        && !threats().context(s).threats.length
        && !invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(s.actor)
        && invoke('GameServer/Effects/EffectRestrictions').canUseBasicAction(s.actor);
}

function incoming(unit) {
    const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
    return unit.sessions.some(s => s.pvpDefense || s.pvpRevenge || s.pendingPvpProvocation
        || threats().context(s).threats.length || Awareness.npcThreateningActor(s));
}

function clear(hold) {
    for (const s of hold.unit.sessions) if (s.hotCompetitionHold === hold) s.hotCompetitionHold = null;
}

function hold(unit, mob, action, now, peer, destinations = null) {
    const command = { unit, mob, action, peerId: id(peer), until: now + (action === 'coexist' ? 1000 : WAIT_MS), destinations, nextMove: new Map() };
    for (const s of unit.sessions) {
        invoke('GameServer/Bot/AI/BotPvpTactics').stop(s, s.actor);
        s.currentTargetId = undefined;
        s.actor.unselect?.();
        s.hotCompetitionHold = command;
        s.lastDecision = { action: `competition_${action}`, targetId: mob.fetchId(), peerId: id(peer), at: now };
    }
    unit.owner.backgroundHuntTarget = null;
    return command;
}

// Called before the ordinary hunt state. Incoming combat always wins, including
// an add hitting a different party member while the group is moving away.
function tick(session, now = Date.now()) {
    const command = session.hotCompetitionHold;
    if (!command) return !!session.hotCompetitionCommit && !incoming({ sessions: [session] });
    if (now >= command.until || side(session)?.signature !== command.unit.signature || incoming(command.unit)
        || command.unit.sessions.some(s => !available(s))) { clear(command); return false; }
    if (command.destinations) {
        const to = command.destinations.get(id(session)), bot = session.actor;
        if (to && !bot.state.fetchCasts?.() && !bot.state.fetchHits?.() && !session.pendingPathRequest
            && !bot.state.fetchTowards?.() && Math.hypot(bot.fetchLocX() - to.locX, bot.fetchLocY() - to.locY) > 80
            && now >= Number(command.nextMove.get(id(session)) || 0)) {
            command.nextMove.set(id(session), now + 1500);
            bot.moveTo({ from: loc(bot), to });
        }
    }
    return true;
}

// At most one small local exclusion per hunter, never an all-population scan.
function blockedTarget(session, mob, now = Date.now()) {
    if (!autonomous(session)) return false;
    const decision = session.hotCompetitionDecision;
    if (decision?.mob === mob && decision.action !== 'contest' && now < decision.until
        && invoke('GameServer/Bot/AI/BotMobCompetition').owner(mob, now) === decision.claimant) return true;
    const avoid = session.hotCompetitionAvoid;
    if (avoid && now >= avoid.until) session.hotCompetitionAvoid = null;
    return !!avoid && now < avoid.until && Math.hypot(mob.fetchLocX() - avoid.loc.locX, mob.fetchLocY() - avoid.loc.locY) < 1000
        && Math.abs(mob.fetchLocZ() - avoid.loc.locZ) < 500;
}

function beforeAttack(session, mob, now = Date.now(), rng = Math.random) {
    if (!autonomous(session) || mob?.fetchKind?.() !== 'Monster'
        || !threats().alive(mob) || !(mob.fetchHp() > 0)
        || invoke('GameServer/Bot/AI/BotRaidSafety').isProtectedRaidEntity(mob)) return false;
    const Claims = invoke('GameServer/Bot/AI/BotMobCompetition');
    const claimant = Claims.owner(mob, now);
    if (!claimant || !autonomous(claimant.session) || claimant === session.actor
        || invoke('GameServer/Bot/AI/BotPvpRisk').sameParty(session, claimant.session)) return false;
    const a = side(session), b = side(claimant.session);
    if (!a || !b || a.sessions.some(s => b.sessions.includes(s))) return false;
    // An existing NPC fight is not a fresh voluntary encroachment.
    if (incoming(a) || a.sessions.some(s => s.actor.state.fetchHits?.() || s.actor.state.fetchCasts?.())) return false;
    if (tick(session, now)) return true;
    const all = [...a.sessions, ...b.sessions];
    const ready = () => all.every(s => available(s) && threats().distance(s.actor, session.actor) <= 1800)
        && side(session)?.signature === a.signature && side(claimant.session)?.signature === b.signature;
    if (!ready() || all.some(s => s.hotCompetitionCommit)) return true;
    const previous = a.owner.hotCompetitionDecision;
    if (previous?.mob === mob && previous.claimant === claimant && previous.signature === a.signature
        && previous.peerSignature === b.signature && now < previous.until) return previous.action !== 'contest';
    if (now < Math.max(Number(a.owner.nextHotCompetitionAt || 0), Number(b.owner.nextHotCompetitionAt || 0))) {
        hold(a, mob, 'yield', now, claimant.session); return true;
    }
    const ab = memory().assess({ id: id(session) }, { id: id(claimant.session) }, {}, now);
    const ba = memory().assess({ id: id(claimant.session) }, { id: id(session) }, {}, now);
    if (!ab.ready || !ba.ready) { hold(a, mob, 'yield', now, claimant.session); return true; }
    const npcId = Number(mob.fetchSelfId());
    const nearby = invoke('GameServer/World/World').fetchNpcsInRadius(session.actor.fetchLocX(), session.actor.fetchLocY(), 1800);
    const supply = Math.max(1, nearby.filter(n => n.fetchKind?.() === 'Monster' && n.fetchSelfId() === npcId
        && threats().alive(n) && n.fetchHp() > 0 && Math.abs(n.fetchLocZ() - session.actor.fetchLocZ()) < 500).length);
    const unit = s => ({ partyId: s.party?.partyId, size: s.sessions.length,
        level: s.sessions.reduce((sum, m) => sum + m.actor.fetchLevel(), 0) / s.sessions.length });
    const Voice = invoke('GameServer/Bot/AI/BotChatVoice');
    const outcome = Policy.decide({ pressure: (all.length / supply), actor: unit(a), peer: unit(b),
        towardPeer: ab, towardActor: ba, actorPersona: Voice.profile(session), peerPersona: Voice.profile(claimant.session), rng });
    all.forEach(s => { s.nextHotCompetitionAt = now + COOLDOWN_MS; });
    a.owner.hotCompetitionDecision = { mob, claimant, signature: a.signature, peerSignature: b.signature,
        action: outcome.action, until: now + COOLDOWN_MS };
    a.sessions.forEach(s => { s.hotCompetitionDecision = a.owner.hotCompetitionDecision; });
    report.decisions[outcome.action] = (report.decisions[outcome.action] || 0) + 1;
    const event = { at: now, actorId: id(session), peerId: id(claimant.session), action: outcome.action, reason: outcome.reason };
    report.recent = [...report.recent, event].slice(-12);
    if (outcome.action === 'contest') return false; // Only the later accepted attack writes an offense.
    if (outcome.action === 'offer_party' && outcome.accepted) {
        const revisions = all.map(s => memory().snapshot(id(s))?.revision);
        const valid = () => ready() && !incoming(a) && all.every((s, i) => revisions[i] !== undefined
            && memory().snapshot(id(s))?.revision === revisions[i]);
        const relationships = () => a.sessions.every(x => b.sessions.every(y => [[x, y], [y, x]].every(([s, t]) => {
            const r = memory().assess({ id: id(s) }, { id: id(t) });
            return r.ready && r.disposition !== 'hostile' && !r.diplomaticEnemy;
        })));
        hold(a, mob, 'offer_party', now, claimant.session);
        const spot = invoke('GameServer/Bot/AI/SpotService').findCurrentSpot(loc(session.actor));
        const context = { at: now, spotId: spot?.id, npcId, mob };
        const pending = context.spotId && relationships()
            ? require('./HotCompetitionParty').form([a, b], context, () => valid() && relationships())
            : Promise.resolve({ ok: false, reason: 'party_context_unavailable' });
        a.owner.hotCompetitionPending = pending.then(result => {
            Object.assign(event, result);
            if (result.ok) report[result.recruited ? 'recruits' : 'parties']++;
            else report.rejected++;
        }).catch(error => { Object.assign(event, { ok: false, reason: 'party_error', error: error.message }); report.rejected++; });
        return true;
    }
    let destinations = null;
    if (outcome.action === 'avoid') {
        const plans = a.sessions.map(s => invoke('GameServer/Bot/AI/BotRetreatPlanner').plan(s.actor, claimant,
            { distance: 1400 }));
        if (plans.every(p => p.safe && p.movesAway && p.routeUsable)) {
            destinations = new Map(a.sessions.map((s, i) => [id(s), plans[i].requestedTo]));
            a.sessions.forEach(s => { s.hotCompetitionAvoid = { loc: loc(mob), until: now + COOLDOWN_MS }; });
            report.avoids++;
        }
    }
    const action = destinations ? 'avoid' : outcome.action === 'coexist' ? 'coexist' : 'yield';
    if (action === 'yield') report.yields++;
    Object.assign(event, { ok: true, executed: action, affectedIds: a.sessions.map(id) });
    hold(a, mob, action, now, claimant.session, destinations);
    a.sessions.forEach(s => tick(s, now));
    return true;
}

module.exports = { beforeAttack, tick, blockedTarget, side, report, WAIT_MS, COOLDOWN_MS };
