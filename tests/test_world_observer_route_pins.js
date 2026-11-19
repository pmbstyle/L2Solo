// Pins every responsibility group of WorldObserverServer.route (redirect,
// world reads, teleport control, market and knowledge reads, clan reads,
// clan-order and crest mutations, detail reads, static delivery, 404) by
// calling route directly with a fake request and response: no port, no live
// database. SQLite reads resolve to empty rows so each branch answers with its
// own shape.
const assert = require('assert');
const { Readable } = require('stream');
require('./helpers/databaseIsolation');
require('../src/Global');
const Database = invoke('Database');
Database.execute = async () => [];
const Observer = invoke('WorldObserver/WorldObserverServer');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const TEXT_404 = { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not found' };
const JSON_PARSE_ERROR = "Expected property name or '}' in JSON at position 1 (line 1 column 2)";

function call(method, url, { body, address = '127.0.0.1', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const request = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
        Object.assign(request, { url, method, headers, socket: { remoteAddress: address } });
        const out = { status: null, headers: null, body: undefined, writes: 0 };
        const timer = setTimeout(() => reject(new Error(`${method} ${url} did not answer`)), 5000);
        const response = {
            writeHead(status, head) { out.writes++; out.status = status; out.headers = head; },
            end(data) {
                clearTimeout(timer);
                out.body = data;
                assert.strictEqual(out.writes, 1, `${method} ${url} must write its head once`);
                resolve(out);
            }
        };
        assert.strictEqual(Observer.route(request, response), undefined, 'route answers asynchronously or inline, never returns a value');
    });
}

const json = (out) => JSON.parse(Buffer.isBuffer(out.body) ? out.body.toString('utf8') : out.body);

async function expectExact(method, url, expected, options) {
    const out = await call(method, url, options);
    assert.strictEqual(out.status, expected.status, `${method} ${url} status`);
    assert.deepStrictEqual(out.headers, expected.headers, `${method} ${url} headers`);
    if ('json' in expected) assert.deepStrictEqual(json(out), expected.json, `${method} ${url} body`);
    else assert.strictEqual(out.body, expected.body, `${method} ${url} body`);
    return out;
}

const methodNotAllowed = (allow) => ({ status: 405, headers: { Allow: allow }, body: undefined });
const jsonReply = (status, body) => ({ status, headers: JSON_HEADERS, json: body });

async function expectFile(url, contentType, includes) {
    const out = await call('GET', url);
    assert.strictEqual(out.status, 200, `${url} status`);
    assert.strictEqual(out.headers['Content-Type'], contentType, `${url} content type`);
    assert.strictEqual(out.headers['Cache-Control'], 'public, max-age=0, must-revalidate', `${url} cache control`);
    assert.match(out.headers.ETag, /^W\/"asset-\d+-\d+"$/, `${url} etag`);
    assert(Buffer.isBuffer(out.body) && out.body.length === out.headers['Content-Length'], `${url} body is the file`);
    if (includes) assert(out.body.toString('utf8').includes(includes), `${url} must serve the file holding ${includes}`);
    const cached = await call('GET', url, { headers: { 'if-none-match': out.headers.ETag } });
    assert.strictEqual(cached.status, 304, `${url} revalidates`);
    assert.strictEqual(cached.body, undefined);
}

(async () => {
    // Redirect of the bare roots.
    await expectExact('GET', '/', { status: 302, headers: { Location: '/observer/' }, body: undefined });
    await expectExact('GET', '/observer', { status: 302, headers: { Location: '/observer/' }, body: undefined });

    // World reads: snapshot (ETag revalidation), bootstrap, search, clan social, status.
    const snapshot = await call('GET', '/observer/api/snapshot');
    assert.strictEqual(snapshot.status, 200);
    assert.deepStrictEqual(Object.keys(snapshot.headers), ['Cache-Control', 'ETag', 'X-Observer-Revision', 'Content-Type', 'Content-Length']);
    assert.strictEqual(snapshot.headers['Cache-Control'], 'no-cache');
    assert.strictEqual(snapshot.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.strictEqual(Buffer.byteLength(snapshot.body), snapshot.headers['Content-Length']);
    assert.strictEqual(typeof json(snapshot), 'object');
    const snapshotCached = await call('GET', '/observer/api/snapshot', { headers: { 'if-none-match': snapshot.headers.ETag } });
    assert.strictEqual(snapshotCached.status, 304, 'the snapshot revalidates by ETag');
    assert.deepStrictEqual(Object.keys(snapshotCached.headers), ['Cache-Control', 'ETag', 'X-Observer-Revision']);
    const bootstrap = await call('GET', '/observer/api/world/bootstrap');
    assert.strictEqual(bootstrap.status, 200);
    assert.deepStrictEqual(bootstrap.headers, JSON_HEADERS);
    assert(['epoch', 'revision', 'bounds', 'mapTiles', 'bots', 'players'].every((key) => key in json(bootstrap)), 'bootstrap carries the world frame');
    await expectExact('POST', '/observer/api/characters/search', methodNotAllowed('GET'));
    await expectExact('GET', '/observer/api/characters/search?q=s', jsonReply(200, { characters: [] }));
    await expectExact('GET', '/observer/api/clans/social', jsonReply(200, { enabled: false }));
    await expectExact('POST', '/observer/api/clans/social', methodNotAllowed('GET'));
    const status = await call('GET', '/observer/api/world/status');
    assert.strictEqual(status.status, 200);
    assert.deepStrictEqual(status.headers, JSON_HEADERS);
    assert(['epoch', 'generatedAt', 'uptimeMs', 'raidBosses'].every((key) => key in json(status)));

    // Teleport control: method, loopback, body parsing, validation.
    const teleport = '/observer/api/control/teleport-player-to-raid';
    await expectExact('GET', teleport, methodNotAllowed('POST'));
    await expectExact('POST', teleport, jsonReply(403, { ok: false, error: 'loopback_only' }), { body: '{}', address: '10.0.0.1' });
    await expectExact('POST', teleport, jsonReply(400, { ok: false, error: 'invalid_player_or_raid_boss' }), { body: '{}' });
    await expectExact('POST', teleport, jsonReply(400, { ok: false, error: JSON_PARSE_ERROR }), { body: '{bad' });

    // Market and knowledge reads.
    await expectExact('POST', '/observer/api/market', methodNotAllowed('GET'));
    await expectExact('GET', '/observer/api/market', jsonReply(500, { error: 'SQLite is not initialized (afk-trade:list)' }));
    await expectExact('POST', '/observer/api/market/history', methodNotAllowed('GET'));
    await expectExact('GET', '/observer/api/market/history?itemId=x', jsonReply(400, { error: 'invalid_market_item' }));
    const meta = await call('GET', '/observer/api/knowledge/meta');
    assert.strictEqual(meta.status, 200);
    assert.strictEqual(json(meta).schemaVersion, 1);
    const items = await call('GET', '/observer/api/knowledge/items?q=sword&limit=1');
    assert.strictEqual(items.status, 200);
    assert.deepStrictEqual([json(items).limit, json(items).items.length], [1, 1], 'query parameters reach the item list');
    const adena = await call('GET', '/observer/api/knowledge/items/57');
    assert.deepStrictEqual([adena.status, json(adena).id, json(adena).name], [200, 57, 'Adena']);
    await expectExact('GET', '/observer/api/knowledge/items/999999999', jsonReply(404, { error: 'Item not found' }));
    const npcs = await call('GET', '/observer/api/knowledge/npcs?limit=1');
    assert.deepStrictEqual([npcs.status, json(npcs).limit, json(npcs).items.length], [200, 1, 1]);
    await expectExact('GET', '/observer/api/knowledge/npcs/999999999', jsonReply(404, { error: 'NPC not found' }));

    // World changes and clan reads.
    const changes = await call('GET', '/observer/api/world/changes?since=0');
    assert.strictEqual(changes.status, 200);
    assert.deepStrictEqual(changes.headers, JSON_HEADERS);
    assert.strictEqual(json(changes).reset, true, 'an unknown revision asks the client to reset');
    const clans = await call('GET', '/observer/api/clans');
    assert.strictEqual(clans.status, 200);
    assert.deepStrictEqual([json(clans).total, typeof json(clans).totals], [0, 'object']);
    await expectExact('POST', '/observer/api/clan-order-items', methodNotAllowed('GET'));
    await expectExact('GET', '/observer/api/clan-order-items?q=sword&limit=2', jsonReply(200, { query: 'sword', items: [] }));

    // Clan-order mutations: method gate, body parsing and size limit before any service call.
    await expectExact('GET', '/observer/api/clan/1/craft-preview', methodNotAllowed('POST'));
    await expectExact('POST', '/observer/api/clan/1/craft-preview', jsonReply(400, { ok: false, error: JSON_PARSE_ERROR }), { body: '{bad' });
    await expectExact('GET', '/observer/api/clan/1/orders', methodNotAllowed('POST'));
    await expectExact('POST', '/observer/api/clan/1/orders', jsonReply(400, { ok: false, error: JSON_PARSE_ERROR }), { body: '{bad' });
    await expectExact('POST', '/observer/api/clan/1/orders', jsonReply(413, { ok: false, error: 'Request body is too large' }), { body: 'x'.repeat(40000) });
    await expectExact('GET', '/observer/api/clan/1/orders/2', methodNotAllowed('PATCH'));
    await expectExact('PATCH', '/observer/api/clan/1/orders/2', jsonReply(400, { ok: false, error: JSON_PARSE_ERROR }), { body: '{bad' });
    await expectExact('GET', '/observer/api/clan/1/orders/2/pause', methodNotAllowed('POST'));
    await expectExact('POST', '/observer/api/clan/1/orders/2/pause', jsonReply(400, { ok: false, error: JSON_PARSE_ERROR }), { body: '{bad' });
    await expectExact('POST', '/observer/api/clan/1/orders/2/pause', jsonReply(413, { ok: false, error: 'Request body is too large' }), { body: 'x'.repeat(20000) });

    // Clan crest: three methods on one path.
    await expectExact('PUT', '/observer/api/clan/1/crest', methodNotAllowed('GET, POST, DELETE'));
    await expectExact('POST', '/observer/api/clan/1/crest', jsonReply(400, { ok: false, code: 'invalid_crest_pixels' }), { body: '{}' });
    await expectExact('DELETE', '/observer/api/clan/0/crest', jsonReply(400, { ok: false, code: 'invalid_clan' }));
    await expectExact('GET', '/observer/api/clan/1/crest', jsonReply(404, { error: 'Clan crest not found' }));
    const generate = '/observer/api/clan/1/crest/generate';
    const crestRequest = { body: '{"prompt":"gold crown"}', headers: { 'content-type': 'application/json; charset=utf-8' } };
    const crestGenerationEnabled = options.default.ClanSimulation.localCrestGenerationEnabled;
    options.default.ClanSimulation.localCrestGenerationEnabled = false;
    await expectExact('GET', generate, methodNotAllowed('POST'));
    await expectExact('OPTIONS', generate, methodNotAllowed('POST'));
    await expectExact('POST', generate, jsonReply(415, { ok: false, code: 'invalid_crest_content_type' }), { body: crestRequest.body });
    await expectExact('POST', generate, jsonReply(409, { ok: false, code: 'crest_generation_disabled' }), crestRequest);
    options.default.ClanSimulation.localCrestGenerationEnabled = true;
    await expectExact('POST', generate, jsonReply(409, { ok: false, code: 'target_not_player_managed' }), crestRequest);
    options.default.ClanSimulation.localCrestGenerationEnabled = crestGenerationEnabled;

    // Detail reads.
    await expectExact('POST', '/observer/api/bot/1/relationships', methodNotAllowed('GET'));
    await expectExact('GET', '/observer/api/bot/1/relationships', jsonReply(404, { error: 'Bot not found' }));
    await expectExact('GET', '/observer/api/clan/1', jsonReply(500, { error: 'SQLite is not initialized (clan-warehouse:list)' }));
    await expectExact('GET', '/observer/api/bot/1', jsonReply(404, { error: 'Bot not found' }));
    await expectExact('POST', '/observer/api/actor/bot/1/inventory', methodNotAllowed('GET'));
    await expectExact('GET', '/observer/api/actor/bot/1/inventory', jsonReply(404, { error: 'Character not found' }));
    await expectExact('GET', '/observer/api/actor/bot/1', jsonReply(404, { error: 'Actor not found' }));

    // Static delivery: icon catalogue, icons, application pages, public files.
    await expectFile('/observer/item-icons/supplemental.json', 'application/json; charset=utf-8');
    await expectFile('/observer/item-icons/weapon_small_sword_i00.png', 'image/png');
    await expectExact('GET', '/observer/item-icons/%E0%A4%A', TEXT_404);
    await expectExact('GET', '/observer/item-icons/nope.png', TEXT_404);
    await expectFile('/observer/database', 'text/html; charset=utf-8', 'knowledge-base.js');
    await expectFile('/observer/database/items/71', 'text/html; charset=utf-8', 'knowledge-base.js');
    await expectFile('/observer/market', 'text/html; charset=utf-8', 'market.js');
    await expectFile('/observer/market/', 'text/html; charset=utf-8', 'market.js');
    await expectFile('/observer/world', 'text/html; charset=utf-8', '/observer/appShell.js');
    await expectFile('/observer/', 'text/html; charset=utf-8', '/observer/appShell.js');
    await expectFile('/observer/format.js', 'application/javascript; charset=utf-8', 'WorldObserverFormat');
    await expectExact('GET', '/observer/unknown-section', TEXT_404);
    await expectExact('GET', '/observer/api/unknown-endpoint', TEXT_404);
    await expectExact('GET', '/elsewhere', TEXT_404);

    console.log('Observer route pins: redirect, world reads, teleport control, market and knowledge, clan reads, clan-order and crest mutations, detail reads, static delivery and 404 passed');
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
