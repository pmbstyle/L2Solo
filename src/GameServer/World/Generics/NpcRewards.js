const DataCache = invoke('GameServer/DataCache');
const SpeckMath = invoke('GameServer/SpeckMath');
const BotLootEtiquette = invoke('GameServer/Bot/AI/BotLootEtiquette');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const ProgressionRates = invoke('GameServer/ProgressionRates');

function isBotSession(session) {
    return !!(session && (session.constructor.name === 'BotSession' || (session.accountId && session.accountId.startsWith('bot_'))));
}

function maybeBragAboutLoot(session, selfId, amount) {
    if (Math.random() >= 0.15) return;

    try {
        const BotManager = invoke('GameServer/Bot/BotManager');
        DataCache.fetchItemFromSelfId(selfId, (itemDetails) => {
            const itemName = itemDetails.template.name;
            const adenaLoot = selfId === 57;
            const lootPhrases = adenaLoot ? [
                `Aha! Got some sweet adena (${amount} gold)!`,
                `Money money! +${amount} adena.`,
                `Sweet, ${amount} adena from that monster!`,
                `This farming is really paying off! Got ${amount} adena.`
            ] : [
                `Whoa! Just got ${itemName}! Nice drop.`,
                `Aha! Got a sweet ${itemName}!`,
                `Nice! This creature dropped ${itemName}.`,
                `Looted ${itemName}! Today is my lucky day!`
            ];
            const phrase = lootPhrases[Math.floor(Math.random() * lootPhrases.length)];
            setTimeout(() => {
                BotManager.botSay(session, phrase);
            }, 500 + Math.random() * 500);
        });
    } catch (err) {
        console.error("Bot loot brag error:", err);
    }
}

function awardDirect(world, session, selfId, amount, stackable) {
    if (stackable) {
        world.purchaseItem(session, selfId, amount);
    } else {
        for (let index = 0; index < amount; index++) {
            world.purchaseItem(session, selfId, 1);
        }
    }
    maybeBragAboutLoot(session, selfId, amount);
}

function awardDrop(world, session, npc, selfId, amount) {
    DataCache.fetchItemFromSelfId(selfId, (itemDetails) => {
        const stackable = utils.crushOb(itemDetails).stackable === true;
        if (isBotSession(session) && !(session.partyCompanion === true && session.followPlayerSession)) {
            awardDirect(world, session, selfId, amount, stackable);
            return;
        }

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
    const leaderSession = session?.partyCompanion === true && session.followPlayerSession
        ? session.followPlayerSession
        : session;
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
