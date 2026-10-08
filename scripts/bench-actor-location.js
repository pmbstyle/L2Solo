'use strict';
const { performance } = require('node:perf_hooks');
const benchRoot = process.env.L2NODE_BENCH_ROOT || require('node:path').resolve(__dirname, '..');
require(require('node:path').join(benchRoot, 'src/Global'));
const World = invoke('GameServer/World/World');
const optional = file => require('node:fs').existsSync(require('node:path').join(benchRoot, 'src', file + '.js'));
const ColdTableChannel = optional('GameServer/Bot/Population/ColdTableChannel') ? invoke('GameServer/Bot/Population/ColdTableChannel').ColdTableChannel : null;
const Source = optional('GameServer/World/MainActorPublicationSource') ? invoke('GameServer/World/MainActorPublicationSource').native() : null;

function sample(n, fn) {
    for (let i = 0; i < 1000; i++) fn(i);
    const t = performance.now(); for (let i = 0; i < n; i++) fn(i);
    return (performance.now() - t) * 1000 / n;
}
async function bench(count) {
    World.user = { sessions: [], revision: 0 };
    const sessions = [];
    let seed = 73;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < count; i++) {
        const actor = { id: 5000000 + i, x: random() * 50000, y: random() * 50000, online: true,
            fetchId() { return this.id; }, fetchLocX() { return this.x; }, fetchLocY() { return this.y; },
            fetchLocZ() { return 0; }, fetchIsOnline() { return this.online; } };
        const session = { actor, accountId: i < 2 ? `player_bench_${i}` : `bot_bench_${i}`, fetchAccountId() { return this.accountId; } };
        actor.baseX = Math.floor(actor.x / 6000) * 6000 + 100;
        actor.x = actor.baseX;
        actor.session = session; World.insertUser(session); sessions.push(session);
    }
    const moving = sessions[0]; moving.actor.baseX = moving.actor.x = 100; moving.actor.y = 100; World.updateUserLocation?.(moving);
    let messages = 0, rows = 0;
    const channel = ColdTableChannel && Source ? new ColdTableChannel({ schedule: callback => setImmediate(callback), maxMessageBytes: 256 * 1024 }) : null;
    channel?.register('actors', { key: ref => ref.id, eventDriven: true, streamed: { source: Source, recipient: 'cold' } });
    channel?.attach({}, 'bench', payload => { messages++; rows += payload.tables.reduce((n, table) => n + table.rows.length, 0); return true; },
        { streamedTables: ['actors'] });
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
    messages = rows = 0;
    const moveUs = sample(count * 40 * 100, i => { const session = sessions[i % count];
        session.actor.x = session.actor.baseX + Math.floor(i / count) % 40; World.updateUserLocation?.(session); });
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
    const nearUs = sample(20000, () => World.fetchVisibleUsers(moving, moving.actor));
    const scanUs = sample(20000, () => sessions.filter(session => session !== moving && session.actor.fetchIsOnline()
        && (session.actor.x - moving.actor.x) ** 2 + (session.actor.y - moving.actor.y) ** 2 < 6000 ** 2));
    console.log(JSON.stringify({ actors: count, stepsPerSecond: 40, moveUs, nearUs, scanUs, messages, rows }));
    channel?.stop?.();
}
(async () => { await bench(200); await bench(1000); })().catch(error => { console.error(error); process.exitCode = 1; });
