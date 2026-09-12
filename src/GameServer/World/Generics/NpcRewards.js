const DataCache = invoke('GameServer/DataCache');
const SpeckMath = invoke('GameServer/SpeckMath');
const BotLootEtiquette = invoke('GameServer/Bot/AI/BotLootEtiquette');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const ProgressionRates = invoke('GameServer/ProgressionRates');

function isBotSession(session) {
    return !!(session && (session.constructor.name === 'BotSession' || (session.accountId && session.accountId.startsWith('bot_'))));
}

function awardDrop(world, session, npc, selfId, amount) {
    DataCache.fetchItemFromSelfId(selfId, (itemDetails) => {
        const stackable = utils.crushOb(itemDetails).stackable === true;
        const instances = stackable ? 1 : amount;
        const instanceAmount = stackable ? amount : 1;
        for (let index = 0; index < instances; index++) {
            spawnGroundDrop(world, session, npc, selfId, instanceAmount);
        }
        if (!isBotSession(session)) {
            BotLootEtiquette.observeDrop(session, npc, selfId, amount);
        }
    });
}

function spawnGroundDrop(world, session, npc, selfId, amount) {
    const point = new SpeckMath.Circle(npc.fetchLocX(), npc.fetchLocY(), 50).createPointWithin();
    const leaderSession = PartyCompanionService.groundLootLeader(session);
    world.spawnItem(session, selfId, amount, {
        ...point.toCoords(),
        locZ: npc.fetchLocZ() - 10,
        // Ground items have no native owner metadata in this runtime. Keep a
        // lightweight provenance marker so an idle party never treats another
        // group's nearby drop as its own recovery work.
        partyLootLeaderId: Number(leaderSession?.actor?.fetchId?.() || 0)
    }, (item) => {
        PartyCompanionService.queueRandomGroundPickup(session, item);
    });
}

function npcRewards(session, npc) {
    DataCache.fetchNpcRewardsFromSelfId(npc.fetchSelfId(), (result) => {
        const rewards = result.rewards ?? [];
        const dropState = npc.model ?? npc;
        const rewardContext = {
            npcLevel: npc.fetchLevel?.() ?? npc.model?.level,
            killerLevel: dropState.dropLastAttackerLevel ?? session?.actor?.fetchLevel?.(),
            attackerLevels: dropState.dropAttackerLevels ?? []
        };

        rewards.forEach((reward) => {
            const groupRoll = ProgressionRates.rewardGroupRoll(reward, 'drop', rewardContext);
            if (groupRoll.hit) {
                const item = ProgressionRates.selectDropItem(reward, groupRoll.itemRate);
                if (!item) return;
                const amount = ProgressionRates.rollDropAmount(reward, item, groupRoll.itemRate);
                awardDrop(this, session, npc, item.selfId, amount);
            }
        });
    });
}

module.exports = npcRewards;
