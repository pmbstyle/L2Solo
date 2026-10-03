const assert = require('assert');
const http = require('http');
const { once } = require('events');
require('../src/Global');
const Observer = invoke('WorldObserver/WorldObserverServer');

(async () => {
    const server = http.createServer(Observer.route);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
        await Promise.all(['/observer/overview', '/observer/characters?kind=services', '/observer/parties?q=Leader', '/observer/dungeons/cruma_tower', '/observer/actors/player/7', '/observer/rankings', '/observer/raid-bosses'].map(async route => {
            const response = await fetch(origin + route);
            assert.strictEqual(response.status, 200, `${route} must support direct visits and reload`);
            const html = await response.text();
            assert(html.includes('/observer/appShell.js'));
            assert(html.includes('/observer/appearance.js'));
        }));
        const map = await fetch(origin + '/observer/map-tiles/20_20.webp');
        assert.strictEqual(map.status, 200);
        assert.strictEqual(map.headers.get('content-type'), 'image/webp');
        const bytes = Buffer.from(await map.arrayBuffer());
        assert.strictEqual(bytes.toString('ascii', 8, 12), 'WEBP');
        for (const [route, script] of [['/observer/market', 'market.js'], ['/observer/database/items/71', 'knowledge-base.js']]) {
            const response = await fetch(origin + route);
            assert.strictEqual(response.status, 200);
            const html = await response.text();
            assert(html.includes(script));
            assert(html.includes('/observer/appShell.js'));
        }
        assert.strictEqual((await fetch(origin + '/observer/unknown-section')).status, 404);
        console.log('Observer application HTTP routes: direct visits, shared appearance/navigation and local WebP assets passed');
    } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
