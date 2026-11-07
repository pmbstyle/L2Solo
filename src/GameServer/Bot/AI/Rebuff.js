'use strict';

// The rebuff decision (Situations rebuff, woken by buffs_expired and a town arrival):
// how a bot renews its hunting buffs now. One rule for a far step and a near body,
// both taken on the background thread (ColdSimulationWorker rebuffTaken). Its answer,
// stats.rebuff { via: 'none'|'guide'|'hall'|'buffer', providerId, at, done }, is held
// and carried out once by its executor, which marks it done: a far bot's guide visit
// (ColdGuideVisit) and hall visit (ClanHall/ColdVisit) on main, its buffer's sale on
// the background thread (the step's buffOffer, ColdBuffOffer.offer); a body's guide
// trip (HuntingState), hall visit (ClanHall/BotVisit) and purchase (BuffService). A
// trip that fails holds its answer done: nothing more until the next situation.
const NONE = 'none';

// view: { grouped, guide (a Newbie Guide in reach serves its level), hall (its clan
// hall here has support it lacks), provider (a buffer to buy from: its id; true for a
// body, whose providers main reads when it buys; falsy: none) }.
// C4: a newbie walks back to a nearby guide, a clan member renews at its hall in its
// town, a hunter buys from a buffer standing at his spot; a far hunter renews nothing
// else in the field, and a party's buffs are its own. The order (the free ways first)
// is ours.
function decide(view, at) {
    const via = view.grouped ? NONE : view.guide ? 'guide' : view.hall ? 'hall' : view.provider ? 'buffer' : NONE;
    return { via, providerId: via === 'buffer' && typeof view.provider === 'number' ? view.provider : null, at };
}

// The held answer an executor carries out now: this way, not yet done.
function pending(stats, via) {
    const answer = stats?.rebuff;
    return answer && !answer.done && answer.via === via ? answer : null;
}

// The answer carried out, or its trip failed: held, done.
const done = answer => ({ ...answer, done: true });

module.exports = { NONE, decide, pending, done };
