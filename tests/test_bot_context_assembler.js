const assert = require('assert');
require('../src/Global');

const BotBrainContext = invoke('GameServer/Bot/AI/BotBrainContext');
const BotContextAssembler = invoke('GameServer/Bot/AI/BotContextAssembler');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');

async function main() {
    const originalCompact = BotBrainContext.compactStatus;
    const originalMerchantCompact = BotBrainContext.compactMerchantStatus;
    let compactOptions = null;
    let merchantCompactCalls = 0;
    BotEventJournal.resetMemory();
    BotBrainContext.compactStatus = (_session, _status, _text, options) => {
        compactOptions = options;
        return {
        available: true,
        name: 'BoundedBot',
        level: 20,
        mode: 'hunting',
        party: { members: [] },
        inventory: null,
        skills: null
        };
    };
    BotBrainContext.compactMerchantStatus = () => {
        merchantCompactCalls += 1;
        return {
            available: true,
            name: 'BoundedMerchant',
            market: {
                id: 'store-20',
                revision: 1,
                lines: [{ selfId: 625, name: 'Bone Shield', count: 3, unitPrice: 522450, minimumUnitPrice: 450000 }]
            }
        };
    };
    try {
        await BotEventJournal.record({ botId: 20, playerId: 10, eventType: 'level_up', summary: 'Reached level 20.', weight: 4 });
        await BotEventJournal.record({ botId: 20, playerId: 10, eventType: 'trade_completed', summary: 'Received healing potions from the player.', weight: 4 });
        const assembled = await BotContextAssembler.assemble({
            session: { actor: { fetchId: () => 20 } },
            status: { available: true },
            text: 'What skills and items do you have?',
            requestContext: {
                playerId: 10,
                conversation: {
                    summary: 'Player prefers short answers and asked for healing potions.',
                    recentTurns: [
                        { role: 'player', channel: 'tell', text: 'What skills do you have?' },
                        { role: 'bot', channel: 'tell', text: 'I can support the party.' }
                    ]
                }
            }
        });
        assert(assembled.bot?.name === 'BoundedBot', 'authoritative bot state should remain a canonical payload field');
        assert(assembled.fragments.some((fragment) => fragment.id === 'recent_dialogue'));
        assert(assembled.fragments.some((fragment) => fragment.id === 'authoritative_events'));
        assert(assembled.telemetry.skillIntent, 'skill intent should include the skill fragment path');
        assert(assembled.estimatedTokens <= assembled.hardMaxTokens);
        assert(BotContextAssembler.estimateTokens(assembled.fragments) <= 1800);
        await BotContextAssembler.assemble({
            session: { actor: { fetchId: () => 20 } },
            status: { available: true },
            text: 'Do you have soulshots, and can you bring me 100?',
            requestContext: { playerId: 10 }
        });
        assert.strictEqual(compactOptions.includeInventory, true, 'soulshots/bring must include inventory context');
        const followup = await BotContextAssembler.assemble({
            session: { actor: { fetchId: () => 20 } },
            status: { available: true },
            text: 'Is it better?',
            requestContext: {
                playerId: 10,
                conversation: {
                    recentTurns: [
                        { role: 'player', channel: 'party_chat', text: 'Equip the Tarbar instead of the Bone Staff.' },
                        { role: 'bot', channel: 'party_chat', text: 'I equipped it.' }
                    ]
                }
            }
        });
        assert.strictEqual(followup.telemetry.itemFollowup, true, 'pronoun follow-up should inherit recent equipment context');
        assert.strictEqual(compactOptions.includeEquipment, true);
        assert.strictEqual(compactOptions.includeInventory, true);

        compactOptions = null;
        const merchant = await BotContextAssembler.assemble({
            session: { plan: 'merchant', actor: { fetchId: () => 20 } },
            status: { available: true },
            text: 'How much for the Bone Shield?',
            requestContext: { playerId: 10, playerSession: { actor: { fetchId: () => 10 } } }
        });
        assert.strictEqual(merchantCompactCalls, 1);
        assert.strictEqual(compactOptions, null, 'merchant context must not invoke the general inventory/skill snapshot');
        assert.strictEqual(merchant.telemetry.contextSlice, 'merchant');
        assert.strictEqual(merchant.telemetry.skillIntent, false, 'an item named Shield must not pull the skill slice');
        assert.strictEqual(merchant.bot.market.lines[0].unitPrice, 522450);
        assert.strictEqual(merchant.bot.inventory, undefined);
        assert.strictEqual(merchant.bot.skills, undefined);
        console.log('Bot context assembler checks passed');
    } finally {
        BotBrainContext.compactStatus = originalCompact;
        BotBrainContext.compactMerchantStatus = originalMerchantCompact;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
