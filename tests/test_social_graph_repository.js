const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const SocialGraph = invoke('GameServer/Social/SocialGraphRepository');
const databasePath = path.join(process.cwd(), 'tmp', 'test-social-graph-repository.sqlite');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => {
        fs.rmSync(file, { force: true });
    });
}

async function main() {
    removeDatabaseFiles();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();

    const player = { kind: 'character', key: '2000001', name: 'SocialPlayer' };
    const bot = { kind: 'character', key: '2000002', name: 'SocialBot' };
    const spot = { kind: 'spot', key: 'dragon-valley-east', name: 'Dragon Valley East' };

    try {
        const first = await SocialGraph.recordEvent({
            eventKey: 'party-run:alpha:2000001:2000002',
            eventType: 'party_completed',
            source: player,
            target: bot,
            context: spot,
            salience: 5,
            delta: { affinity: 3, trust: 4, respect: 2, familiarity: 1 },
            payload: { partyId: 'alpha', outcome: 'success' },
            relationMeta: { origin: 'party' },
            occurredAt: 1000
        });
        assert.strictEqual(first.inserted, true);
        assert.strictEqual(first.event.source.id, first.relation.source.id,
            'the immediate event result must expose the persisted source entity id');
        assert.strictEqual(first.event.target.id, first.relation.target.id,
            'the immediate event result must expose the persisted target entity id');
        assert.notStrictEqual(first.event.source.id, first.event.target.id);
        assert.strictEqual(first.event.context.kind, 'spot');
        assert.strictEqual(first.event.context.externalKey, 'dragon-valley-east');
        assert.deepStrictEqual(
            [first.relation.affinity, first.relation.trust, first.relation.respect, first.relation.familiarity],
            [3, 4, 2, 1]
        );
        assert.strictEqual(first.relation.evidenceCount, 1);
        assert.strictEqual(first.relation.revision, 1);
        assert.deepStrictEqual(first.relation.meta, { origin: 'party' });

        const duplicate = await SocialGraph.recordEvent({
            eventKey: 'party-run:alpha:2000001:2000002',
            eventType: 'party_completed',
            source: player,
            target: bot,
            delta: { trust: 99, familiarity: 99 },
            occurredAt: 2000
        });
        assert.strictEqual(duplicate.inserted, false, 'event keys must make retries idempotent');
        assert.deepStrictEqual(
            [duplicate.relation.trust, duplicate.relation.familiarity, duplicate.relation.evidenceCount, duplicate.relation.revision],
            [4, 1, 1, 1],
            'an idempotent retry must not apply relation deltas twice'
        );

        const second = await SocialGraph.recordEvent({
            eventKey: 'combat-help:beta:2000001:2000002',
            eventType: 'combat_helped',
            source: player,
            target: bot,
            delta: { trust: 1000, affinity: 2, familiarity: 2 },
            occurredAt: 3000
        });
        assert.strictEqual(second.inserted, true);
        assert.strictEqual(second.relation.trust, 100, 'relation dimensions must remain clamped');
        assert.strictEqual(second.relation.affinity, 5);
        assert.strictEqual(second.relation.familiarity, 3);
        assert.strictEqual(second.relation.evidenceCount, 2);
        assert.strictEqual(second.relation.revision, 2);

        const familiarityDecay = await SocialGraph.recordEvent({
            eventKey: 'time-decay:beta:2000001:2000002',
            eventType: 'familiarity_decayed',
            source: player,
            target: bot,
            delta: { familiarity: -2 },
            occurredAt: 3500
        });
        assert.strictEqual(familiarityDecay.event.delta.familiarity, -2,
            'the event log must retain the requested familiarity delta');
        assert.strictEqual(familiarityDecay.relation.familiarity, 1,
            'negative familiarity deltas must reduce the materialized relation without crossing zero');
        assert.strictEqual(familiarityDecay.relation.evidenceCount, 3);
        assert.strictEqual(familiarityDecay.relation.revision, 3);

        const reverse = await SocialGraph.recordEvent({
            eventKey: 'insult:gamma:2000002:2000001',
            eventType: 'insulted',
            source: bot,
            target: player,
            delta: { affinity: -4, hostility: 7, familiarity: 1 },
            occurredAt: 4000
        });
        assert.strictEqual(reverse.relation.hostility, 7);
        assert.strictEqual((await SocialGraph.relation(player, bot)).hostility, 0,
            'opposite directions must remain independent');
        assert.strictEqual((await SocialGraph.relation(bot, player)).hostility, 7);

        const neighbors = await SocialGraph.neighbors(player, { targetKinds: ['character'], limit: 10 });
        assert.deepStrictEqual(neighbors.map((relation) => relation.target.externalKey), ['2000002']);

        const clan = await SocialGraph.registerEntity({ kind: 'clan', key: '6000001', name: 'Silver Dawn' });
        assert.strictEqual(clan.kind, 'clan');
        assert.strictEqual((await SocialGraph.findEntity({ kind: 'clan', key: '6000001' })).displayName, 'Silver Dawn');

        const events = await SocialGraph.eventsAfter(0, 10);
        assert.deepStrictEqual(events.map((event) => event.eventKey), [
            'party-run:alpha:2000001:2000002',
            'combat-help:beta:2000001:2000002',
            'time-decay:beta:2000001:2000002',
            'insult:gamma:2000002:2000001'
        ]);
        const cursor = await SocialGraph.advanceProjectionCursor('graph-shadow', events.at(-1).id);
        assert.strictEqual(cursor.lastEventId, events.at(-1).id);
        const unchangedCursor = await SocialGraph.advanceProjectionCursor('graph-shadow', 1);
        assert.strictEqual(unchangedCursor.lastEventId, events.at(-1).id,
            'projection cursors must never move backwards');

        const counts = await Database.execute([
            `SELECT
                (SELECT COUNT(*) FROM social_entities) entities,
                (SELECT COUNT(*) FROM social_events) events,
                (SELECT COUNT(*) FROM social_relations) relations`
        ], 'test:social-counts');
        assert.deepStrictEqual(
            [Number(counts[0].entities), Number(counts[0].events), Number(counts[0].relations)],
            [4, 4, 2],
            'lazy registration must create only referenced entities and directed relation pairs'
        );

        await assert.rejects(
            SocialGraph.recordEvent({
                eventKey: 'collision',
                eventType: 'invalid_self_relation',
                source: player,
                target: player
            }),
            /source and target must differ/
        );

        console.log('Social graph repository checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
