const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const BotConversationStore = invoke('GameServer/Bot/AI/BotConversationStore');
const BotConversationService = invoke('GameServer/Bot/AI/BotConversationService');

function actor(id, name) {
    return {
        fetchId: () => id,
        fetchName: () => name
    };
}

async function main() {
    const databasePath = path.join(process.cwd(), 'tmp', 'test-bot-conversations.sqlite');
    fs.rmSync(databasePath, { force: true });
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    BotConversationStore.resetMemory();

    await Database.createAccount('dialogue_player', 'secret');
    await Database.createAccount('dialogue_player_two', 'secret');
    await Database.createAccount('bot_dialogue', 'secret');
    await Database.createCharacter('dialogue_player', {
        name: 'DialoguePlayer', race: 0, classId: 0, maxHp: 50, maxMp: 25,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
    });
    await Database.createCharacter('dialogue_player_two', {
        name: 'DialoguePlayerTwo', race: 0, classId: 0, maxHp: 50, maxMp: 25,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
    });
    await Database.createCharacter('bot_dialogue', {
        name: 'DialogueBot', race: 0, classId: 0, maxHp: 50, maxMp: 25,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
    });

    const playerId = (await Database.fetchCharacterName('DialoguePlayer'))[0].id;
    const playerTwoId = (await Database.fetchCharacterName('DialoguePlayerTwo'))[0].id;
    const botId = (await Database.fetchCharacterName('DialogueBot'))[0].id;
    const playerSession = { accountId: 'dialogue_player', actor: actor(playerId, 'DialoguePlayer') };
    const playerTwoSession = { accountId: 'dialogue_player_two', actor: actor(playerTwoId, 'DialoguePlayerTwo') };
    const botSession = { accountId: 'bot_dialogue', actor: actor(botId, 'DialogueBot') };

    const first = await BotConversationService.beginTurn({
        playerSession,
        botSession,
        channel: 'client_tell',
        turnId: 'turn-1',
        text: 'Hello, do you remember me?'
    });
    assert.strictEqual(first.inserted, true);
    assert.deepStrictEqual(first.context.recentTurns.map((turn) => turn.text), ['Hello, do you remember me?']);
    assert.strictEqual(await BotConversationService.recordBotReply({
        playerSession,
        botSession,
        turnId: 'turn-1',
        channel: 'client_tell',
        text: 'I remember this conversation.'
    }), true);

    const second = await BotConversationService.beginTurn({
        playerSession,
        botSession,
        channel: 'client_tell',
        turnId: 'turn-2',
        text: 'What did I ask you?'
    });
    assert.deepStrictEqual(
        second.context.recentTurns.map((turn) => turn.text),
        ['Hello, do you remember me?', 'I remember this conversation.', 'What did I ask you?']
    );

    const secondPair = await BotConversationService.beginTurn({
        playerSession: playerTwoSession,
        botSession,
        channel: 'client_tell',
        turnId: 'other-1',
        text: 'This is a different player.'
    });
    assert.deepStrictEqual(secondPair.context.recentTurns.map((turn) => turn.text), ['This is a different player.']);

    const duplicate = await BotConversationService.beginTurn({
        playerSession,
        botSession,
        channel: 'client_tell',
        turnId: 'turn-2',
        text: 'What did I ask you?'
    });
    assert.strictEqual(duplicate.inserted, false, 'the same turn identity must not be stored twice');

    const stored = await BotConversationStore.context(playerId, botId, { limit: 10 });
    const throughId = stored.recentTurns[1].id;
    const summary = await BotConversationStore.setSummary({
        playerId,
        botId,
        summary: 'The player asked whether the bot remembers the conversation.',
        summaryThroughId: throughId,
        expectedVersion: stored.version
    });
    assert.strictEqual(summary.ok, true);
    const compacted = await BotConversationStore.context(playerId, botId, { limit: 10 });
    assert.match(compacted.summary, /remembers/);
    assert.deepStrictEqual(compacted.recentTurns.map((turn) => turn.text), ['What did I ask you?']);
    const conflict = await BotConversationStore.setSummary({
        playerId,
        botId,
        summary: 'stale summary',
        summaryThroughId: throughId,
        expectedVersion: stored.version
    });
    assert.strictEqual(conflict.ok, false);
    assert.strictEqual(conflict.reason, 'version_conflict');

    BotConversationStore.resetMemory();
    const afterRestart = await BotConversationService.contextFor(playerSession, botSession, { limit: 10 });
    assert.match(afterRestart.summary, /remembers/);
    assert.deepStrictEqual(afterRestart.recentTurns.map((turn) => turn.text), ['What did I ask you?']);

    console.log('Bot conversation store checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
