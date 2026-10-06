'use strict';
const reasons = { town: 0, revived: 0, level: 0, weight: 0, bag: 0, money: 0 };
let hotEconomyBuilds = 0, reportedBuilds = 0, reportedAt = Date.now();
function statsFor(session) {
    return session.coldLifeState ? (session.coldLifeState.stats ||= {}) : (session.decisionStats ||= {});
}
function raiseDecision(session, reason) {
    if (!Object.hasOwn(reasons, reason)) throw new TypeError('unknown_decision_event');
    const stats = statsFor(session);
    stats.decisionSeq = Math.max(0, Math.trunc(Number(stats.decisionSeq) || 0)) + 1;
    stats.activityLeaf = 0;
    reasons[reason]++;
    return stats.decisionSeq;
}
function marksFor(session, actor) {
    const bag = invoke('GameServer/Bot/Population/SurvivalFloor').bagMarks(actor);
    return { level: Number(actor.fetchLevel?.() || 0), weight: bag.weight, bag: bag.full,
        money: Number(invoke('GameServer/Bot/Economy/PurchaseFunding').moneyReached({
            adena: actor.backpack?.fetchTotalAdena?.() ?? actor.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() ?? 0,
            stats: session.coldLifeState?.stats || session.heldEconomy?.statsPacket || statsFor(session)
        })) };
}
function observe(session, actor) {
    const marks = marksFor(session, actor), prior = session.decisionMarks;
    if (prior) {
        if (marks.level > prior.level) raiseDecision(session, 'level');
        if (marks.weight !== prior.weight) raiseDecision(session, 'weight');
        if (marks.bag > prior.bag) raiseDecision(session, 'bag');
        if (marks.money > prior.money) raiseDecision(session, 'money');
    }
    session.decisionMarks = marks;
}
function hold(session, actor, context) {
    if (session.coldLifeState) Object.assign(statsFor(session), context.statsPacket);
    else Object.assign(statsFor(session), { decisionSeq: context.statsPacket.decisionSeq, activityLeaf: context.statsPacket.activityLeaf });
    session.economySeq = Number(statsFor(session).decisionSeq || 0);
    // Keep only the decision. Native actor state is read when executing an improvement.
    const leaf = context.network.activity;
    const activity = leaf ? { key: leaf.key, activity: leaf.activity,
        ...(leaf.items ? { items: leaf.items } : {}), ...(leaf.improvement ? { improvement: leaf.improvement } : {}) } : null;
    session.heldEconomy = { network: { activity }, statsPacket: context.statsPacket,
        riskWeight: context.riskWeight };
    session.decisionMarks = marksFor(session, actor);
    hotEconomyBuilds++;
    return session.heldEconomy;
}
function held(session) {
    return session.economySeq === Number(statsFor(session).decisionSeq || 0) ? session.heldEconomy : null;
}
function summary(hotHunters = 0, timestamp = Date.now()) {
    const builds = hotEconomyBuilds - reportedBuilds;
    const perMinute = builds * 60000 / Math.max(1, timestamp - reportedAt) / Math.max(1, hotHunters);
    reportedBuilds = hotEconomyBuilds; reportedAt = timestamp;
    return { hotEconomyBuilds: builds, hotEconomyBuildsPerBotMinute: Math.round(perMinute * 100) / 100,
        total: hotEconomyBuilds, reasons: { ...reasons } };
}
module.exports = { statsFor, raiseDecision, observe, hold, held, summary };
