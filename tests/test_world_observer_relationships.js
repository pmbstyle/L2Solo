const assert = require('assert');
const fs = require('fs'), vm = require('vm');
require('../src/Global');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Manager = invoke('GameServer/Bot/BotManager');
const DB = invoke('Database');
const Api = invoke('WorldObserver/Relationships');
const Ui = require('../src/WorldObserver/public/relationships');
const original = [], patch = (o, k, v) => { const old = o[k]; original.push(() => { o[k] = old; }); o[k] = v; };

async function run() {
    let at = 100000, reads = 0, inspections = 0;
    patch(Date, 'now', () => at);
    patch(Life, 'cachedState', id => [1, 2].includes(id) ? { characterId: id, name: `Bot${id}` } : null);
    patch(Life, 'findByCharacterId', async () => null);
    patch(Manager, 'findSessionById', () => null);
    patch(Memory, 'ensureMany', async ids => { assert.deepStrictEqual(ids, [1]); });
    const row = id => ({ kind: 'character', targetId: id, affinity: -4, trust: -4, hostility: 6, fear: 2,
        reasons: [{ type: 'attacked', at: 99000 }] });
    let targets = [2];
    patch(Memory, 'inspect', () => { inspections++; return { ready: true, revision: 7, relations: targets.map(row) }; });
    patch(Memory, 'assess', () => ({ disposition: 'wary', sourceClanId: 10, targetClanId: 20,
        clanSocial: { ready: true, effective: { trust: -6, hostility: 9, fear: 2 }, individual: { trust: -4, hostility: 6 } } }));
    patch(DB, 'execute', async ([sql, ids]) => {
        reads++; assert.match(sql, /^SELECT id,name,username FROM characters WHERE id IN/);
        assert(ids.length <= 32); return [{ id: 3, name: '<img src=x onerror=alert(1)>', username: 'human' }];
    });
    const [first, second] = await Promise.all([Api.detail(1), Api.detail(1)]);
    assert.strictEqual(first, second, 'parallel viewers coalesce the selected-bot read');
    assert.strictEqual(reads, 0, 'resident bot relationships and names require no SQL');
    assert.strictEqual(inspections, 1);
    assert.strictEqual(first.relations[0].name, 'Bot2');
    assert.strictEqual(first.relations[0].personal.trust, -4);
    assert.strictEqual(first.relations[0].clan.effective.trust, -6, 'clan influence stays separate from personal memory');
    await Api.detail(1); assert.strictEqual(inspections, 1);
    targets = [2, 3, 4]; at += 5001;
    const richer = await Api.detail(1);
    assert.strictEqual(reads, 1, 'unloaded identities use one bounded batch');
    assert.strictEqual(richer.relations[1].actorKind, 'player', 'offline players retain working player links');
    assert.strictEqual(richer.relations[2].actorKind, null, 'deleted identities do not fabricate bot links');
    at += 5001; await Api.detail(1);
    assert.strictEqual(reads, 1, 'name and not-found identities are cached across relationship refreshes');
    assert.strictEqual(await Api.detail(-1), null);
    assert.strictEqual(await Api.detail(999), null);

    const html = Ui.render(richer, { ownerName: '<b>owner</b>', relative: () => '1m ago' });
    assert(html.includes('Attacked me') && html.includes('Clan influence: trust -2 · hostility +3'));
    assert(html.includes('/observer/actors/player/3'));
    assert(!html.includes('<img') && !html.includes('<b>owner</b>'), 'untrusted names are escaped');
    assert(html.includes('Fear 2') && html.includes('Feelings may not be mutual'));
    assert(Ui.render({ ready: true, relations: [] }).includes('No personal encounters remembered'));
    assert(Ui.render({ ready: false }).includes('not available yet'), 'unloaded is distinct from empty memory');
    assert(Ui.render(richer, { filter: 'friendly' }).includes('No remembered relationships in this group'));

    // Exercise the actual card loader against deferred responses and selection changes.
    const app = fs.readFileSync('src/WorldObserver/public/app.js', 'utf8');
    const code = app.slice(app.indexOf('function resetRelationships()'), app.indexOf('function relationshipContent('));
    let calls = [], rendered = 0;
    const state = { selectedId: { id: 1, kind: 'bot' }, live: true };
    const context = vm.createContext({ state, document: { hidden: false }, Date, AbortController,
        renderRelationshipPanel: () => { rendered++; }, fetch: (url, options) => new Promise(resolve => calls.push({ url, options, resolve })) });
    vm.runInContext(code, context);
    const load = vm.runInContext('loadRelationships', context);
    const a = load(true); assert.strictEqual(calls.length, 1);
    await load(true); assert.strictEqual(calls.length, 1, 'slow responses cannot overlap polls');
    state.selectedId = { id: 2, kind: 'bot' };
    const b = load(true); assert(calls[0].options.signal.aborted);
    calls[0].resolve({ ok: true, json: async () => ({ ownerId: 1 }) }); await a;
    assert.strictEqual(state.relationships, null, 'old actor response cannot repaint the new card');
    calls[1].resolve({ ok: true, json: async () => ({ ownerId: 2 }) }); await b;
    assert.strictEqual(state.relationships.ownerId, 2); assert.strictEqual(rendered, 1);
    await load(); assert.strictEqual(calls.length, 2);
    at += 10001; context.document.hidden = true; await load(); assert.strictEqual(calls.length, 2);
    context.document.hidden = false; state.live = false; await load(); assert.strictEqual(calls.length, 2);
    state.live = true; state.selectedId = null; await load(); assert.strictEqual(calls.length, 2);
    console.log('Observer relationships: cached bounded reads, batched offline names, personal/clan separation, safe rendering, selection races and polling guards passed');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => original.reverse().forEach(restore => restore()));
