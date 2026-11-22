const assert = require('assert');
require('../src/Global');

const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');
const RaidMemory = require('../src/GameServer/Bot/AI/BotRaidMemory');
const PvpMemory = require('../src/GameServer/Bot/AI/BotPvpMemory');

async function main() {
    BotEventJournal.resetMemory();
    const first = await BotEventJournal.record({
        playerId: 10,
        botId: 20,
        eventType: 'kill_streak',
        summary: 'Defeated a goblin.',
        dedupeKey: 'spot:goblin',
        coalesceWindowMs: 60000
    });
    const second = await BotEventJournal.record({
        playerId: 10,
        botId: 20,
        eventType: 'kill_streak',
        summary: 'Defeated another goblin.',
        dedupeKey: 'spot:goblin',
        coalesceWindowMs: 60000,
        createdAt: first.event.updatedAt + 1000
    });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.coalesced, true);
    assert.strictEqual(second.event.count, 2);

    await BotEventJournal.record({ playerId: 11, botId: 20, eventType: 'chat', summary: 'Other player event.' });
    await BotEventJournal.record({ botId: 20, eventType: 'level_up', summary: 'Reached level 12.', createdAt: first.event.updatedAt + 2000 });
    const pairEvents = await BotEventJournal.recent({ playerId: 10, botId: 20, limit: 10 });
    assert.deepStrictEqual(pairEvents.map((event) => event.eventType), ['kill_streak', 'level_up']);
    assert.strictEqual(pairEvents[0].count, 2);
    assert.strictEqual(BotEventJournal.memorySize(), 3);
    await BotEventJournal.record({ playerId: 10, botId: 20, eventType: 'llm_decision', summary: 'Goblin defeated (model proposal).' });
    assert.strictEqual((await BotEventJournal.search({ playerId: 10, botId: 20, query: 'goblin' })).length, 1,
        'a model proposal cannot become evidence of a real encounter');
    const Knowledge = invoke('GameServer/Bot/AI/BotDialogueKnowledge');
    const context = { session: { characterId: 20 }, playerSession: { actor: { fetchId: () => 10 } }, playerMessage: 'Do you remember yesterday\'s raid?' };
    const unknown = await Knowledge.execute({ action: 'recall_event', query: 'raid' }, context);
    assert.strictEqual(unknown.terminalReply, "I don't remember that.");
    const wrongTool = await Knowledge.execute({ action: 'recall_event', query: 'clan opinion' },
        { ...context, playerMessage: 'what do you think about your clan?' });
    assert.strictEqual(wrongTool.reason, 'no_match_for_current_question');
    assert.strictEqual(wrongTool.terminalReply, undefined, 'a wrong read must not force a memory answer to a present-tense question');
    const hunt = { ...context, playerMessage: 'Do you remember that goblin?' };
    const known = await Knowledge.execute({ action: 'recall_event', query: 'goblin' }, hunt);
    assert.strictEqual(known.rows.length, 1);
    assert(!known.terminalReply);
    const publicHistory = await Knowledge.execute({ action: 'recall_event', query: 'goblin' }, { ...hunt, publicChat: true });
    assert.strictEqual(publicHistory.rows.length, 0, 'public answers cannot use a private pair event');

    const { DatabaseSync } = require('node:sqlite');
    const Database = invoke('Database');
    const saved = { ready: Database.isReady, execute: Database.execute };
    const sql = new DatabaseSync(':memory:');
    sql.exec(`CREATE TABLE bot_activity_journal(id INTEGER PRIMARY KEY, playerId INTEGER, botId INTEGER,
        eventType TEXT, summary TEXT, weight INTEGER, dedupeKey TEXT, count INTEGER, createdAt INTEGER,
        updatedAt INTEGER, metaJson TEXT);
        CREATE TABLE characters(id INTEGER PRIMARY KEY, name TEXT);
        INSERT INTO characters VALUES (10, 'Aden'), (11, 'Giran'), (20, 'BoundedBot'), (21, 'OtherBot');`);
    const insert = sql.prepare('INSERT INTO bot_activity_journal VALUES (?, ?, ?, ?, ?, 1, NULL, 1, 1, 1, NULL)');
    insert.run(1, 10, 20, 'drop', 'Received 100% Coal');
    insert.run(2, 11, 20, 'drop', 'Received private Coal');
    insert.run(3, null, 20, 'level_up', 'Coal hunting level-up');
    insert.run(4, 10, 20, 'llm_decision', 'Received invented Coal');
    Database.isReady = () => true;
    Database.execute = async ([statement, args]) => sql.prepare(statement).all(...args);
    BotEventJournal.resetMemory();
    try {
        assert.deepStrictEqual((await BotEventJournal.search({ botId: 20, playerId: 10, query: 'Coal' })).map(row => row.id), [1, 3]);
        assert.deepStrictEqual((await BotEventJournal.search({ botId: 20, playerId: 10, query: '100%' })).map(row => row.id), [1],
            'wildcards in a model query are literal search text');
        assert.deepStrictEqual((await BotEventJournal.search({ botId: 20, query: 'Coal' })).map(row => row.id), [3]);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const write = (statement, args) => sql.prepare(statement).run(...args);
        const firstRaid = { bossId: 1, bossName: 'Queen Ant', instanceId: 'first-spawn', status: 'defeated',
            at: yesterday.getTime() + 60000, participants: [10, 20], bots: [20] };
        RaidMemory.writeOutcome(write, firstRaid);
        RaidMemory.writeOutcome(write, firstRaid);
        RaidMemory.writeOutcome(write, { ...firstRaid, instanceId: 'next-spawn', at: today.getTime() + 1000,
            participants: [11, 20] });
        RaidMemory.writeOutcome(write, { ...firstRaid, status: 'failed', partyId: 'raid-party', at: firstRaid.at - 1000 });
        RaidMemory.writeOutcome(write, { ...firstRaid, status: 'active' });
        assert.equal((await BotEventJournal.search({ botId: 20, combatKind: 'raid' })).length, 3);
        assert.equal((await BotEventJournal.search({ botId: 20, includeCombat: false, query: 'Queen Ant' })).length, 0);
        const recorded = await Knowledge.execute({ action: 'recall_event', query: 'рейд' },
            { ...context, playerMessage: 'Помнишь наш вчерашний рейд?' });
        assert.deepStrictEqual(recorded.rows.map(row => [row.outcome, row.bossName, row.speakerParticipationConfirmed,
            row.otherParticipants]), [['failed', 'Queen Ant', true, ['Aden']], ['defeated', 'Queen Ant', true, ['Aden']]]);
        const byName = await Knowledge.execute({ action: 'recall_event', query: 'Queen Ant' },
            { ...context, playerMessage: 'Помнишь Queen Ant?' });
        assert.strictEqual(byName.rows.at(-1).speakerParticipationConfirmed, false);
        const compoundRaid = await Knowledge.execute({ action: 'recall_event', query: 'Queen Ant raid yesterday' },
            { ...context, playerMessage: 'What happened in the Queen Ant raid yesterday?' });
        assert.deepStrictEqual(compoundRaid.rows.map(row => row.outcome), ['failed', 'defeated']);
        assert.equal(compoundRaid.replyReason, 'multiple_recorded_events', 'an ambiguous outcome question should not pick an attempt');
        const otherPlayer = await Knowledge.execute({ action: 'recall_event', query: 'рейд' },
            { ...context, playerSession: { actor: { fetchId: () => 11 } }, playerMessage: 'Помнишь наш вчерашний рейд?' });
        assert.equal(otherPlayer.rows.length, 0, 'a later raid with this player does not prove yesterday was shared');
        const absent = await Knowledge.execute({ action: 'recall_event', query: 'raid' },
            { ...context, session: { characterId: 21 } });
        assert.equal(absent.terminalReply, "I don't remember that.");
        const clan = await Knowledge.execute({ action: 'recall_event', query: 'raid' }, { ...context, publicChat: true });
        assert(clan.rows.length && clan.rows.every(row => !('otherParticipants' in row) && !('speakerParticipationConfirmed' in row)));
        RaidMemory.writeOutcome(write, { ...firstRaid, bossName: 'Carnage Lord Gato', instanceId: 'gato',
            participants: [11, 21], bots: [21] });
        RaidMemory.writeOutcome(write, { ...firstRaid, bossName: 'Captain of Red Flag Shaka', instanceId: 'shaka',
            participants: [10, 21], bots: [21], at: today.getTime() + 1000 });
        for (const playerMessage of ['how war you last boss raid?', 'we killed the boss?', 'at the raid have we killed the boss?']) {
            const read = Knowledge.readForQuestion(playerMessage);
            assert.equal(read?.action, 'recall_event', playerMessage);
            const remembered = await Knowledge.execute(read, { ...context, session: { characterId: 21 }, playerMessage });
            assert.deepStrictEqual(remembered.rows.map(row => [row.bossName, row.outcome, row.speakerParticipationConfirmed]),
                [['Captain of Red Flag Shaka', 'defeated', true]], playerMessage);
            assert.equal(remembered.terminalReply, 'Captain of Red Flag Shaka was defeated. We were both there.');
        }
        assert.equal(Knowledge.readForQuestion('What loot dropped from the last boss raid?'), null,
            'a question about loot must remain a separate lookup');

        const confirmedFight = { source: 'cold', key: 'yesterday-fight', at: firstRaid.at,
            outcome: 'retreated', sides: [[20, 10], [11]], losingSide: 1, bots: [20] };
        PvpMemory.writeOutcome(write, confirmedFight);
        PvpMemory.writeOutcome(write, confirmedFight);
        PvpMemory.writeOutcome(write, { source: 'hot', key: 'today-kill', at: today.getTime() + 1000,
            outcome: 'killed', sides: [[11], [20]], losingSide: 1, bots: [20],
            kills: [{ killerId: 11, victimId: 20, outcome: 'pk' }] });
        PvpMemory.writeOutcome(write, { ...confirmedFight, key: 'only-a-contest', outcome: 'displaced' });
        assert.equal((await BotEventJournal.search({ botId: 20, combatKind: 'pvp' })).length, 2);
        assert.equal((await BotEventJournal.search({ botId: 20, includeCombat: false, query: 'PvP' })).length, 0);
        const yesterdayPvp = await Knowledge.execute({ action: 'recall_event', query: 'пвп' },
            { ...context, playerMessage: 'Помнишь наш вчерашний ПвП?' });
        assert.equal(yesterdayPvp.rows.length, 1);
        assert.deepStrictEqual(yesterdayPvp.rows.map(({ outcome, allies, opponents, resultForBot, speakerSide }) =>
            ({ outcome, allies, opponents, resultForBot, speakerSide })),
        [{ outcome: 'retreated', allies: ['Aden'], opponents: ['Giran'], resultForBot: 'won', speakerSide: 'ally' }]);
        const todayPvp = await Knowledge.execute({ action: 'recall_event', query: 'Giran' },
            { ...context, playerMessage: 'Что сегодня было в ПвП с Giran?' });
        assert.equal(todayPvp.rows.length, 1);
        assert.equal(todayPvp.rows[0].resultForBot, 'was_killed');
        assert.deepStrictEqual(todayPvp.rows[0].kills, [{ killer: 'Giran', victim: 'self', credit: 'pk' }]);
        for (const playerMessage of ["What happened in today's PvP?", 'Чем закончилось сегодняшнее ПвП?']) {
            const current = await Knowledge.execute({ action: 'recall_event' }, { ...context, playerMessage });
            assert.deepStrictEqual(current.rows.map(row => row.resultForBot), ['was_killed']);
        }
        const question = 'In the PvP with Giran yesterday, who retreated?';
        const retreated = await Knowledge.execute(Knowledge.readForQuestion(question), { ...context, playerMessage: question });
        assert.strictEqual(retreated.rows[0].retreatingSide, 'opposing_side');
        assert.strictEqual(retreated.terminalReply, 'Giran was on the opposing side. The opposing side retreated.');
        assert.equal((await Knowledge.execute({ action: 'recall_event', query: 'Giran' },
            { ...context, playerMessage: 'Помнишь Giran?' })).rows.length, 2);
        const publicPvp = await Knowledge.execute({ action: 'recall_event', query: 'pvp' },
            { ...context, playerMessage: 'What happened in PvP?', publicChat: true });
        assert.equal(publicPvp.rows.length, 2);
        assert(publicPvp.rows.every(row => !('allies' in row) && !('opponents' in row) && !('kills' in row)));
        const publicByName = query => Knowledge.execute({ action: 'recall_event', query },
            { ...context, playerMessage: `Did you fight ${query} in PvP?`, publicChat: true });
        assert.deepStrictEqual(await publicByName('Giran'), await publicByName('Unknown'),
            'public recall cannot confirm participation by matching a hidden name');
        assert.equal((await publicByName('Giran')).rows.length, 0);

        const longSide = Array.from({ length: 8 }, (_, index) => 30 + index);
        const insertCharacter = sql.prepare('INSERT INTO characters VALUES (?, ?)');
        for (const id of longSide) insertCharacter.run(id, id === 37 ? 'LastFighter' : `LastFighter${id}`);
        PvpMemory.writeOutcome(write, { source: 'cold', key: 'large-fight', at: today.getTime() + 2000,
            outcome: 'killed', sides: [[20], longSide], losingSide: 1, bots: [20],
            kills: [{ killerId: 20, victimId: 36, outcome: 'pvp' }] });
        const named = await Knowledge.execute({ action: 'recall_event', query: 'LastFighter' },
            { ...context, playerMessage: 'Tell me about your PvP with LastFighter' });
        assert.equal(named.rows.length, 1);
        assert.equal(named.rows[0].opponents.length, 6);
        assert.equal(named.rows[0].opponents[0], 'LastFighter', 'the exact match survives a crowded side and precedes partial matches');
        assert.deepStrictEqual(named.rows[0].sideCounts, [1, 8]);
        assert.deepStrictEqual(named.rows[0].kills, [{ killer: 'self', victim: 'LastFighter36', credit: 'pvp' }]);
    } finally {
        Database.isReady = saved.ready; Database.execute = saved.execute;
        BotEventJournal.resetMemory(); sql.close();
    }
    console.log('Bot activity journal checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
