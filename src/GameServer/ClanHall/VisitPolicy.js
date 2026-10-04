const BotErrands = invoke('GameServer/Bot/Population/BotErrands');

// Errands a hall visit or a hall restart must not interrupt: every errand
// except a warehouse errand, a merchant store or a craft shop/station. A PvP
// fight and an alliance quest come from the view: a hot bot keeps them on its
// session, a cold bot in stats.
const ERRAND_FLAGS = ['clanPartyObjective', 'clanGoal', 'supplyErrand', 'marketReturn', 'craftReturn',
    'warehouseWorkflow', 'mammonReturn', 'partyMarketReturn'];

// A bot in the world, as the hall rule sees it.
function fromSession(session, actor) {
    return {
        karma: Number(actor.fetchKarma?.() || 0),
        grouped: !!(session.followPlayerSession || session.partyCompanion || session.hotBackgroundPartyId),
        merchant: session.plan === 'merchant' || !!actor.fetchPrivateStore?.(),
        accountName: session.accountId || '',
        pvp: !!session.pvpEncounter,
        allianceDuty: !!(session.clanAllianceQuest || session.clanAllianceSupportLeaderId),
        stats: session.coldLifeState?.stats || null
    };
}

// A cold bot, as the hall rule sees it.
function fromState(state) {
    return {
        karma: Number(state?.stats?.karma || 0),
        grouped: !!(state?.party?.partyId || state?.partyId),
        merchant: state?.activity === 'merchant',
        accountName: state?.accountName || '',
        pvp: !!state?.stats?.pvpEncounter,
        allianceDuty: !!state?.stats?.clanAllianceQuest,
        stats: state?.stats || null
    };
}

// Whether a bot may use its clan hall: visit the manager, or with
// options.restart restart there after death. Red bots, merchants, craft
// accounts and bots in a fight, an alliance quest or an errand never do. A
// grouped bot does not leave its group for the hall and restarts in town; it
// takes the manager's support only when it already stands at the manager
// (options.atManager), which only a bot in the world can.
function mayUse(view, options = {}) {
    if (view.karma !== 0 || view.merchant || view.pvp || view.allianceDuty) return false;
    if (String(view.accountName).startsWith('bot_craft_')) return false;
    if (BotErrands.busyWith(view, ERRAND_FLAGS)) return false;
    if (view.grouped && (options.restart || !options.atManager)) return false;
    return true;
}

module.exports = { ERRAND_FLAGS, fromSession, fromState, mayUse };
