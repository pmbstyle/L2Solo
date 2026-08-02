const assert = require('assert');
require('../src/Global');

const BotBrainContext = invoke('GameServer/Bot/AI/BotBrainContext');
const BotContextAssembler = invoke('GameServer/Bot/AI/BotContextAssembler');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');

async function main() {
    const originalCompact = BotBrainContext.compactStatus;
    BotEventJournal.resetMemory();
    BotBrainContext.compactStatus = () => ({
        available: true,
        name: 'BoundedBot',
        level: 20,
        mode: 'hunting',
        party: { members: [] },
        inventory: null,
        skills: null
    });
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
        console.log('Bot context assembler checks passed');
    } finally {
        BotBrainContext.compactStatus = originalCompact;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
