const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const World = invoke('GameServer/World/World');
const Observer = invoke('WorldObserver/WorldObserverServer');
const PlayerActivitySignal = invoke('GameServer/Bot/Population/PlayerActivitySignal');

const originalUser = World.user;
try {
    PlayerActivitySignal.reset();
    World.user = { sessions: [] };
    assert.strictEqual(Observer.observerCacheTtl(1000), 2000,
        'idle observer snapshots may refresh frequently');

    const player = {
        accountId: 'observer_player',
        actor: { fetchIsOnline: () => true }
    };
    World.user.sessions = [player];
    assert.strictEqual(Observer.observerCacheTtl(2000), 30000,
        'a real player must increase observer snapshot reuse');

    const companion = {
        accountId: 'bot_observer_companion',
        actor: { fetchIsOnline: () => true },
        partyCompanion: true,
        followPlayerSession: player
    };
    World.user.sessions.push(companion);
    assert.strictEqual(Observer.observerCacheTtl(3000), 30000,
        'an active player party must maximize observer snapshot reuse');

    World.user.sessions = [];
    assert.strictEqual(Observer.observerCacheTtl(10000), 30000,
        'disconnect grace must keep the protected observer policy');
    assert.strictEqual(Observer.observerCacheTtl(40000), 2000,
        'observer policy must return to idle after the relog grace window');

    const firstResponse = {
        status: 0,
        headers: null,
        body: null,
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        end(body = null) { this.body = body; }
    };
    Observer.sendSnapshotJson({ headers: {} }, firstResponse, '{"ok":true}');
    assert.strictEqual(firstResponse.status, 200);
    assert.strictEqual(firstResponse.headers['Cache-Control'], 'no-cache');
    assert.strictEqual(firstResponse.body, '{"ok":true}');
    assert(firstResponse.headers.ETag, 'snapshot response must expose a validator');

    const conditionalResponse = {
        status: 0,
        headers: null,
        body: 'unexpected',
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        end(body = null) { this.body = body; }
    };
    Observer.sendSnapshotJson({ headers: { 'if-none-match': firstResponse.headers.ETag } }, conditionalResponse, '{"ok":true}');
    assert.strictEqual(conditionalResponse.status, 304, 'matching snapshots must avoid retransmission');
    assert.strictEqual(conditionalResponse.body, null);
} finally {
    World.user = originalUser;
    PlayerActivitySignal.reset();
}

function requestAsset(headers = {}) {
    return new Promise((resolve) => {
        const response = {
            status: 0,
            headers: null,
            body: 'unexpected',
            writeHead(status, responseHeaders) {
                this.status = status;
                this.headers = responseHeaders;
            },
            end(body = null) {
                this.body = body;
                resolve(this);
            }
        };
        Observer.sendFile(
            { headers },
            response,
            path.join(__dirname, '..', 'src', 'WorldObserver', 'public', 'worldState.js')
        );
    });
}

(async () => {
    const assetPath = path.join(__dirname, '..', 'src', 'WorldObserver', 'public', 'worldState.js');
    const asset = await requestAsset();
    assert.strictEqual(asset.status, 200);
    assert(asset.headers.ETag, 'static observer assets must expose a validator');
    assert.strictEqual(asset.headers['Cache-Control'], 'public, max-age=0, must-revalidate');
    assert.strictEqual(Number(asset.headers['Content-Length']), fs.statSync(assetPath).size);

    const cachedAsset = await requestAsset({ 'if-none-match': asset.headers.ETag });
    assert.strictEqual(cachedAsset.status, 304, 'unchanged SPA assets must use the browser cache');
    assert.strictEqual(cachedAsset.body, null);
    console.log('World observer cache policy checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
