const refreshPartyMemberships = require('../../../World/PartyMembershipPublication');
const Speech = invoke('GameServer/Bot/AI/BotSpeechTemplates');
const BotBuffs       = invoke('GameServer/Bot/AI/BotBuffs');
const PartyCombatState = invoke('GameServer/Bot/AI/PartyCombatState');
const CompanionNavigationRecovery = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');
const TownNpcBodies = invoke('GameServer/Bot/AI/TownNpcBodies');
const TownChatter = invoke('GameServer/Bot/AI/TownChatter');
const HotTownRebuff = invoke('GameServer/Bot/AI/HotTownRebuff');

const RETURN_TELEPORT_SETTLE_MS = 1250;
const NEWBIE_GUIDE_ROUTE_RETRY_COOLDOWN_MS = 60000;

function returnLocation(session) {
    const resume = session.resumeAfterBuff;
    if (resume?.plan === 'following' && resume.followPlayerSession?.actor?.fetchIsOnline()) {
        if (resume.botStay && resume.stayLocation) {
            return resume.stayLocation;
        }

        const leader = resume.followPlayerSession.actor;
        return {
            locX: leader.fetchLocX() + utils.oneFromSpan(-60, 60),
            locY: leader.fetchLocY() + utils.oneFromSpan(-60, 60),
            locZ: leader.fetchLocZ()
        };
    }

    return session.preBuffLocation || session.initialSpawnCoord || null;
}

function resumePreviousPlan(session, bot) {
    const resume = session.resumeAfterBuff;
    if (resume?.plan === 'following' && resume.followPlayerSession?.actor?.fetchIsOnline()) {
        session.plan = 'following';
        session.followPlayerSession = resume.followPlayerSession;
        session.partyCompanion = true;
        session.botStay = resume.botStay;
        session.stayLocation = resume.stayLocation;
        session.roleDecision = {
            role: resume.role,
            action: 'refresh_buffs',
            reason: 'newbie_blessing_done',
            at: Date.now()
        };
        refreshPartyMemberships([session], invoke);
    } else {
        session.plan = session.preBuffPlan || 'hunting';
    }

    session.resumeAfterBuff = undefined;
    session.preBuffPlan = undefined;
    session.preBuffLocation = undefined;
    session.currentTargetId = undefined;
    bot.unselect();
}

function finishVisit(session, bot, Generics) {
    const resume = session.resumeAfterBuff;
    const target = returnLocation(session);
    const returningToCompanion = resume?.plan === 'following'
        && resume.followPlayerSession?.actor?.fetchIsOnline?.();
    TownNpcApproach.reset(session);
    CompanionNavigationRecovery.clear(session);

    if (resume?.waitForSafePartyReturn && resume.followPlayerSession && PartyCombatState.isActive(resume.followPlayerSession)) {
        session.roleDecision = {
            role: resume.role,
            action: 'return_to_party',
            reason: 'wait_for_safe_teleport',
            at: Date.now()
        };
        return false;
    }

    if (resume?.returnMode === 'teleport' && target) {
        if (!resume.returnTeleportStartedAt) {
            resume.returnTeleportStartedAt = Date.now();
            Generics.teleportTo(session, bot, target);
            return false;
        }
        if (Date.now() - resume.returnTeleportStartedAt < RETURN_TELEPORT_SETTLE_MS) {
            return false;
        }
        resumePreviousPlan(session, bot);
        return true;
    }

    resumePreviousPlan(session, bot);
    if (returningToCompanion && target) {
        bot.moveTo({
            from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
            to: target
        });
    } else if (session.plan === 'hunting') {
        // A solo hot bot should leave town through its local gatekeeper. The
        // hunting state will select and announce the actual farming ground.
        session.pendingFarmDepartureAnnouncement = true;
    }
    return true;
}

function abandonUnreachableVisit(session, bot, BotAI, reason = 'newbie_guide_route_unreachable') {
    const resume = session.resumeAfterBuff;
    const following = resume?.plan === 'following' && resume.followPlayerSession?.actor?.fetchIsOnline?.();
    session.plan = following ? 'following' : (session.preBuffPlan || 'hunting');
    if (following) {
        session.followPlayerSession = resume.followPlayerSession;
        session.partyCompanion = true;
        session.botStay = resume.botStay;
        session.stayLocation = resume.stayLocation;
        refreshPartyMemberships([session], invoke);
    }
    session.newbieGuideRetryAt = Date.now() + NEWBIE_GUIDE_ROUTE_RETRY_COOLDOWN_MS;
    session.resumeAfterBuff = undefined;
    session.preBuffPlan = undefined;
    session.preBuffLocation = undefined;
    session.currentTargetId = undefined;
    session.roleDecision = {
        ...(session.roleDecision || {}),
        action: 'refresh_buffs',
        reason,
        at: Date.now()
    };
    TownNpcApproach.reset(session);
    CompanionNavigationRecovery.clear(session);
    bot.unselect?.();
    bot.automation?.abortAll?.(bot);
    TownChatter.say(session, BotAI, 'newbie-guide-unreachable', Speech.lines('town.newbie-guide-unreachable'), { priority: 'coordination' });
}

// The guide of this trip, chosen once at its start and kept on the trip's
// resume record (every trip entry writes a fresh one): null = no guide trip.
function chosenGuide(session, bot, BotAI) {
    const resume = session.resumeAfterBuff ??= {};
    if (resume.newbieGuide === undefined) resume.newbieGuide = HotTownRebuff.tripGuide(session, bot, BotAI);
    return resume.newbieGuide;
}

module.exports = {
    tick(session, bot, Generics, BotAI) {
        const resume = session.resumeAfterBuff;
        if (Number(resume?.readyAt || 0) > Date.now()) return;

        const guide = chosenGuide(session, bot, BotAI);
        const shouldVisitGuide = !!guide && (resume?.conditionalNewbieBuff !== true || BotBuffs.needsNewbieRefresh(bot, 0));
        if (!shouldVisitGuide) {
            finishVisit(session, bot, Generics);
            return;
        }
        // A guide beyond its town radius has no town path, so its route failures
        // are not counted: a route that leaves that radius ends the trip as unreachable.
        if (!HotTownRebuff.guideInReach(bot, guide)) {
            abandonUnreachableVisit(session, bot, BotAI, 'newbie_guide_route_left_town');
            return;
        }

        const guideTarget = {
            locX: guide.locX,
            locY: guide.locY,
            locZ: guide.locZ,
            npcSelfId: guide.npcSelfId,
            name: guide.name ? `${guide.name} Newbie Guide` : 'Newbie Guide',
            town: guide.name,
            head: guide.head
        };
        const guideApproach = TownNpcApproach.planOpen(session, bot, guideTarget, 'newbie_guide', { bodiesNear: TownNpcBodies.seenBy(bot) });
        const readyToInteract = guideApproach?.ready === true;

        if (!readyToInteract) {
            const navigation = CompanionNavigationRecovery.move(
                session,
                bot,
                guideApproach?.destination || guideTarget,
                'newbie_guide',
                {
                    targetActor: null,
                    arrivalRadius: guideApproach?.arrivalRadius ?? 220
                }
            );
            if (navigation.status === 'exhausted') {
                TownNpcApproach.reset(session);
                abandonUnreachableVisit(session, bot, BotAI);
            }
        } else {
            TownNpcApproach.reset(session);
            CompanionNavigationRecovery.clear(session);
            session.newbieGuideRetryAt = undefined;
            BotBuffs.applyFullNewbieBlessing(session, bot, Generics);
            HotTownRebuff.markCompleted(
                session,
                bot,
                BotAI,
                session.resumeAfterBuff?.townVisitKey || null
            );
            const returningToParty = session.resumeAfterBuff?.plan === 'following';
            TownChatter.say(session, BotAI, 'newbie-blessing-complete', returningToParty
            ? Speech.lines('town.newbie-blessing-complete.party')
            : Speech.lines('town.newbie-blessing-complete.solo'));
            finishVisit(session, bot, Generics);
        }
    }
};
