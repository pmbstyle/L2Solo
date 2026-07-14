const DataCache      = invoke('GameServer/DataCache');
const ServerResponse = invoke('GameServer/Network/Response');
const ConsoleText    = invoke('GameServer/ConsoleText');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');

const SPOIL_SKILL_ID = 254;
const SPOIL_FESTIVAL_SKILL_ID = 302;
const SWEEP_SKILL_ID = 42;
const SPOILED_CORPSE_TIME = 30000;

function fetchSpoilGroups(npc) {
    let spoils = [];
    DataCache.fetchNpcRewardsFromSelfId(npc.fetchSelfId(), (result) => {
        spoils = result.spoils ?? [];
    });
    return spoils;
}

function hasSpoils(npc) {
    return fetchSpoilGroups(npc).some((group) => (group.items ?? []).length > 0);
}

function rollSpoils(npc) {
    const awarded = [];
    const dropState = npc.model ?? npc;
    const rewardContext = {
        npcLevel: npc.fetchLevel?.() ?? npc.model?.level,
        killerLevel: dropState.dropLastAttackerLevel,
        attackerLevels: dropState.dropAttackerLevels ?? []
    };

    fetchSpoilGroups(npc).forEach((group) => {
        const groupRoll = ProgressionRates.rewardGroupRoll(group, 'spoil', rewardContext);
        if (!groupRoll.hit) {
            return;
        }

        let number = Math.random() * 100;
        let rewardPartition = 0;

        for (const item of group.items ?? []) {
            rewardPartition += item.chance;

            if (number <= rewardPartition) {
                const baseAmount = utils.oneFromSpan(item.min, item.max);
                awarded.push({
                    selfId: item.selfId,
                    name: item.name,
                    amount: ProgressionRates.scaleAmount(baseAmount, groupRoll.amountMultiplier)
                });
                break;
            }
        }
    });

    return awarded;
}

function spendSkillMp(session, actor, skill) {
    if (actor.fetchMp() < skill.fetchConsumedMp()) {
        ConsoleText.transmit(session, ConsoleText.caption.depletedMp);
        return false;
    }

    actor.setMp(actor.fetchMp() - skill.fetchConsumedMp());
    actor.statusUpdateVitals(actor);
    actor.automation.replenishVitals(actor);
    return true;
}

function castUtilitySkill(session, actor, target, skill, effect) {
    if (actor.state.fetchCasts()) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    if (actor.fetchMp() < skill.fetchConsumedMp()) {
        ConsoleText.transmit(session, ConsoleText.caption.depletedMp);
        return;
    }

    skill.setCalculatedHitTime(skill.fetchHitTime());
    session.dataSendToMeAndOthers(ServerResponse.skillStarted(actor, target.fetchId(), skill), actor);
    session.dataSendToMe(ServerResponse.skillDurationBar(skill.fetchCalculatedHitTime()));
    actor.state.setCasts(true);

    setTimeout(() => {
        actor.state.setCasts(false);
        if (actor.isDead()) {
            return;
        }
        if (!spendSkillMp(session, actor, skill)) {
            return;
        }
        effect();
    }, skill.fetchCalculatedHitTime());
}

function spoilRecipientSession(session, npc, selfId) {
    const leaderSession = session?.partyCompanion === true && session.followPlayerSession
        ? session.followPlayerSession
        : session;
    const distribution = PartyCompanionService.distributionForLeader(leaderSession);
    if (distribution === 2 || distribution === 4) {
        return PartyCompanionService.resolveLootSession(session, selfId, npc);
    }
    return session;
}

const SpoilSweep = {
    isSpoilSkill(selfId) {
        return Number(selfId) === SPOIL_SKILL_ID;
    },

    isSpoilFestivalSkill(selfId) {
        return Number(selfId) === SPOIL_FESTIVAL_SKILL_ID;
    },

    isSweepSkill(selfId) {
        return Number(selfId) === SWEEP_SKILL_ID;
    },

    isSweepable(npc) {
        return !!npc.model.spoil?.spoiled && !npc.model.spoil?.swept && hasSpoils(npc);
    },

    corpseTime(npc) {
        const corpseTime = Number(npc.fetchCorpseTime()) || 0;
        return this.isSweepable(npc) ? Math.max(corpseTime, SPOILED_CORPSE_TIME) : corpseTime;
    },

    castSpoil(session, actor, npc, skill) {
        this.castSpoilTargets(session, actor, [npc], skill);
    },

    castSpoilTargets(session, actor, targets, skill) {
        const eligible = [...new Map((targets || []).filter(Boolean)
            .map((npc) => [npc.fetchId?.(), npc]))].map(([, npc]) => npc)
            .filter((npc) => npc.fetchAttackable?.() && !npc.isDead?.() && hasSpoils(npc) && !npc.model.spoil?.spoiled);
        if (eligible.length === 0) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        castUtilitySkill(session, actor, eligible[0], skill, () => {
            const spoiled = eligible.filter((npc) => !npc.isDead?.() && !npc.model.spoil?.spoiled);
            if (spoiled.length === 0) {
                session.dataSendToMe(ServerResponse.actionFailed());
                return;
            }

            spoiled.forEach((npc) => {
                npc.model.spoil = {
                    spoiled: true,
                    swept: false,
                    spoilerId: actor.fetchId(),
                    spoilerName: actor.fetchName(),
                    spoiledAt: Date.now()
                };
                if (Number(skill.fetchSelfId?.()) === SPOIL_FESTIVAL_SKILL_ID) {
                    const effect = EffectStore.apply(npc, {
                        key: 'spoil_festival',
                        id: SPOIL_FESTIVAL_SKILL_ID,
                        level: skill.fetchLevel?.() || 1,
                        name: skill.fetchName?.() || 'Spoil Festival',
                        type: 'debuff',
                        category: 'spoil',
                        stats: { pAtkSpdMul: 0.77 },
                        durationMs: 15000
                    });
                    EffectTicker.scheduleExpiry(session, npc, effect);
                }
                npc.enterCombatState(session, actor);
            });
            console.info('SpoilSweep :: %s spoiled %d targets with %s', actor.fetchName(), spoiled.length, skill.fetchName());
            ConsoleText.transmit(session, ConsoleText.caption.spoilActivated);
        });
    },

    castSweep(session, actor, npc, skill) {
        if (!npc.isDead()) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        if (!this.isSweepable(npc)) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        if (npc.model.spoil?.spoilerId && npc.model.spoil.spoilerId !== actor.fetchId()) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        castUtilitySkill(session, actor, npc, skill, () => {
            if (!this.isSweepable(npc)) {
                session.dataSendToMe(ServerResponse.actionFailed());
                return;
            }

            const awarded = rollSpoils(npc);
            npc.model.spoil.swept = true;

            if (awarded.length === 0) {
                session.dataSendToMe(ServerResponse.actionFailed());
            } else {
                awarded.forEach((item) => {
                    const recipientSession = spoilRecipientSession(session, npc, item.selfId);
                    invoke('GameServer/World/World').purchaseItem(recipientSession, item.selfId, item.amount);
                    const textName = { kind: ConsoleText.kind.item, value: item.selfId };
                    const textAmount = { kind: ConsoleText.kind.number, value: item.amount };
                    item.amount > 1
                        ? ConsoleText.transmit(recipientSession, ConsoleText.caption.pickupAmountOf, [textName, textAmount])
                        : ConsoleText.transmit(recipientSession, ConsoleText.caption.pickup, [textName]);
                    console.info('SpoilSweep :: %s swept %d %s from %s', actor.fetchName(), item.amount, item.name, npc.fetchName());
                });
            }

            session.dataSendToMeAndOthers(ServerResponse.deleteOb(npc.fetchId()), npc);
            const World = invoke('GameServer/World/World');
            World.npc.spawns = World.npc.spawns.filter((ob) => ob.fetchId() !== npc.fetchId());
        });
    }
};

module.exports = SpoilSweep;
