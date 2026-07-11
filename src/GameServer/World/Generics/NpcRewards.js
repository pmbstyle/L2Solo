const DataCache = invoke('GameServer/DataCache');
const SpeckMath = invoke('GameServer/SpeckMath');
const BotLootEtiquette = invoke('GameServer/Bot/AI/BotLootEtiquette');
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

function awardDirect(world, session, selfId, amount) {
    world.purchaseItem(session, selfId, amount);
    maybeBragAboutLoot(session, selfId, amount);
}

function spawnGroundDrop(world, session, npc, selfId, amount) {
    const point = new SpeckMath.Circle(npc.fetchLocX(), npc.fetchLocY(), 50).createPointWithin();
    world.spawnItem(session, selfId, amount, {
        ...point.toCoords(), locZ: npc.fetchLocZ() - 10
    });
}

function npcRewards(session, npc) {
    DataCache.fetchNpcRewardsFromSelfId(npc.fetchSelfId(), (result) => {
        const rewards = result.rewards ?? [];

        rewards.forEach((reward) => {
            const groupRoll = ProgressionRates.rollGroup(reward.overall, ProgressionRates.groupRate(reward, 'drop'));
            if (groupRoll.hit) {
                let number = Math.random() * 100;
                let rewardPartition = 0;

                for (const item of reward.items) {
                    rewardPartition += item.chance;

                    if (number <= rewardPartition) { // TODO: Remove locZ hack at some point
                        const baseAmount = utils.oneFromSpan(item.min, item.max);
                        const amount = ProgressionRates.scaleAmount(baseAmount, groupRoll.amountMultiplier);
                        if (isBotSession(session) && !(session.partyCompanion === true && session.followPlayerSession)) {
                            awardDirect(this, session, item.selfId, amount);
                        } else {
                            spawnGroundDrop(this, session, npc, item.selfId, amount);
                            if (!isBotSession(session)) {
                                BotLootEtiquette.observeDrop(session, npc, item.selfId, amount);
                            }
                        }
                        break;
                    }
                }
            }
        });
    });
}

module.exports = npcRewards;
