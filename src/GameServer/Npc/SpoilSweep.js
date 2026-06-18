const DataCache      = invoke('GameServer/DataCache');
const ServerResponse = invoke('GameServer/Network/Response');
const ConsoleText    = invoke('GameServer/ConsoleText');

const SPOIL_SKILL_ID = 254;
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
    const optn = options.default.General;
    const awarded = [];

    fetchSpoilGroups(npc).forEach((group) => {
        if (Math.random() * 100 > group.overall * optn.dropChanceRate) {
            return;
        }

        let number = Math.random() * 100;
        let rewardPartition = 0;

        for (const item of group.items ?? []) {
            rewardPartition += item.chance;

            if (number <= rewardPartition) {
                awarded.push({
                    selfId: item.selfId,
                    name: item.name,
                    amount: utils.oneFromSpan(item.min, item.max)
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

const SpoilSweep = {
    isSpoilSkill(selfId) {
        return Number(selfId) === SPOIL_SKILL_ID;
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
        if (!npc.fetchAttackable() || npc.isDead()) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        if (!hasSpoils(npc)) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        if (npc.model.spoil?.spoiled) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        castUtilitySkill(session, actor, npc, skill, () => {
            if (npc.isDead()) {
                session.dataSendToMe(ServerResponse.actionFailed());
                return;
            }

            npc.model.spoil = {
                spoiled: true,
                swept: false,
                spoilerId: actor.fetchId(),
                spoilerName: actor.fetchName(),
                spoiledAt: Date.now()
            };

            console.info('SpoilSweep :: %s spoiled %s', actor.fetchName(), npc.fetchName());
            ConsoleText.transmit(session, ConsoleText.caption.spoilActivated);
            npc.enterCombatState(session, actor);
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
                    invoke('GameServer/World/World').purchaseItem(session, item.selfId, item.amount);
                    const textName = { kind: ConsoleText.kind.item, value: item.selfId };
                    const textAmount = { kind: ConsoleText.kind.number, value: item.amount };
                    item.amount > 1
                        ? ConsoleText.transmit(session, ConsoleText.caption.pickupAmountOf, [textName, textAmount])
                        : ConsoleText.transmit(session, ConsoleText.caption.pickup, [textName]);
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
