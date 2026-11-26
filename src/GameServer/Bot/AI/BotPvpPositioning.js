const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Retreat = invoke('GameServer/Bot/AI/BotRetreatPlanner');
const distance = (a,b) => Math.hypot(Number(a.fetchLocX?.())-Number(b.fetchLocX?.()),Number(a.fetchLocY?.())-Number(b.fetchLocY?.()));
function reposition(session, bot, context, now = Date.now()) {
    if (Roles.inferRole(bot) !== 'archer' || bot.backpack?.fetchTotalWeaponKind?.() !== 'Weapon.Bow'
        || !Restrictions.canMove(bot) || bot.state?.fetchCasts?.() || bot.state?.fetchTowards?.()
        || now-Number(session.lastPvpRangeAt || 0)<3500) return false;
    const threats = context.threats.map(entry=>entry.actor);
    const pressure = threats.filter(actor => !['archer','mage','healer','buffer'].includes(Roles.inferRole(actor))
        && distance(bot,actor)<=450 && Number(actor.fetchDestId?.())===Number(bot.fetchId?.()))
        .sort((a,b)=>distance(bot,a)-distance(bot,b))[0];
    if (!pressure) return false;
    session.lastPvpRangeAt=now;
    const anchor = session.partyCompanion ? invoke('GameServer/Bot/AI/ClanCommandParty').followBody(session)?.actor
        : context.members.length>1 ? context.owner?.actor : null;
    const previewRoute = (from,to) => {
        if (anchor && anchor!==bot && Math.hypot(to.locX-anchor.fetchLocX(),to.locY-anchor.fetchLocY())>900) {
            return {routeUsable:false,route:[],routedTo:to};
        }
        const oldPath=session.lastPathfinding,oldTown=session.townRoutePlan;
        try { return bot.moveTo({from:{...from},to:{...to},previewOnly:true}); }
        finally { session.lastPathfinding=oldPath;session.townRoutePlan=oldTown; }
    };
    const plan = Retreat.plan(bot,pressure,{distance:500,threats,previewRoute});
    if (!plan.safe) return false; // Failed routes retain normal combat during retry delay.
    invoke('GameServer/Bot/AI/BotPvpTactics').stop(session,bot);
    bot.moveTo({from:plan.from,to:{...plan.requestedTo}});
    session.lastCombatDecision={action:'pvp_kite',intent:'restore_firing_distance',reason:'melee_pressure',
        targetId:pressure.fetchId(),at:now};
    return true;
}
module.exports={reposition};
