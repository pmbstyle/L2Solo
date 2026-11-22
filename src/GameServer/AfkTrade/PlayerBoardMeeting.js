'use strict';
// Presentation only. A current travel leg has a clock; a fight or an unrelated
// journey does not. Never turn a route estimate into an arrival guarantee.
function status(session, { life = () => invoke('GameServer/Bot/Population/BotLifeState'), now = Date.now() } = {}) {
    const meeting = session.tradeMeetingPresence;
    if (!meeting || meeting.actorId !== Number(session.actor?.fetchId())) return null;
    const state = meeting.otherId && life().cachedState(meeting.otherId);
    const result = { name: state?.name || 'Merchant', town: meeting.town || '', phase: 'Waiting for the merchant', seconds: 0 };
    if (!state) return result;
    if (state.stats?.partyMeeting === meeting.id) return { ...result, phase: 'Waiting to leave the party' };
    const atPoint = loc => loc && Math.hypot(Number(loc.locX) - meeting.locX,
        Number(loc.locY) - meeting.locY, Number(loc.locZ) - meeting.locZ) <= 200;
    if (atPoint(state.loc)) return { ...result, phase: 'Merchant at the meeting point' };
    if (state.activity === 'fighting') return { ...result, phase: 'Finishing a fight' };
    const travel = state.stats?.travel;
    if (travel && !atPoint(travel.to) && travel.meetingId !== meeting.id) return { ...result, phase: 'Finishing another journey' };
    const route = meeting.route || {};
    const activeLeg = travel && (atPoint(travel.to) || travel.meetingId === meeting.id);
    const intermediate = activeLeg && !atPoint(travel.to);
    const remaining = activeLeg ? Math.max(0, Number(travel.arrivalAt) - now)
        : Math.max(0, Number(route.durationMs) || 0) + Math.max(0, Number(state.stats?.restUntil || 0) - now);
    result.phase = state.activity === 'resting' ? 'Recovering before departure' : intermediate ? 'Travelling to the next stop' : activeLeg ? 'On the way to you' : 'Preparing to travel';
    result.seconds = Number.isFinite(remaining) ? Math.min(604800, Math.ceil(Math.max(0, remaining) / 1000)) : 0;
    return result;
}
module.exports = { status };
