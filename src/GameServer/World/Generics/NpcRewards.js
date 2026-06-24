const DataCache = invoke('GameServer/DataCache');
const SpeckMath = invoke('GameServer/SpeckMath');
const BotLootEtiquette = invoke('GameServer/Bot/AI/BotLootEtiquette');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');

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

function awardPartyLoot(world, session, npc, selfId, amount) {
    if (selfId === 57) {
        PartyCompanionService.adenaAllocations(session, amount, npc)
            .forEach((entry) => world.purchaseItem(entry.session, selfId, entry.amount));
        return;
    }

    const recipientSession = PartyCompanionService.resolveLootSession(session, selfId, npc);
    world.purchaseItem(recipientSession, selfId, amount);
    if (recipientSession === session) {
        maybeBragAboutLoot(session, selfId, amount);
    }
}

function npcRewards(session, npc) {
    DataCache.fetchNpcRewardsFromSelfId(npc.fetchSelfId(), (result) => {
        const rewards = result.rewards ?? [];
        const optn    = options.default.General;

        rewards.forEach((reward) => {
            if (Math.random() * 100 <= reward.overall * optn.dropChanceRate) {
                let number = Math.random() * 100;
                let rewardPartition = 0;

                for (const item of reward.items) {
                    rewardPartition += item.chance;

                    if (number <= rewardPartition) { // TODO: Remove locZ hack at some point
                        const amount = utils.oneFromSpan(item.min, item.max);
                        if (isBotSession(session)) {
                            if (session.partyCompanion === true && session.followPlayerSession) {
                                awardPartyLoot(this, session, npc, item.selfId, amount);
                            } else {
                                awardDirect(this, session, item.selfId, amount);
                            }
                        } else {
                            let point = new SpeckMath.Circle(npc.fetchLocX(), npc.fetchLocY(), 50).createPointWithin();
                            this.spawnItem(session, item.selfId, amount, {
                                ...point.toCoords(), locZ: npc.fetchLocZ() - 10
                            });
                            BotLootEtiquette.observeDrop(session, npc, item.selfId, amount);
                        }
                        break;
                    }
                }
            }
        });
    });
}

module.exports = npcRewards;
