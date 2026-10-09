const assert = require('node:assert/strict');
const { gunzipSync } = require('node:zlib');
const { createJsonResponseCache, sendCachedJson } = require('../src/WorldObserver/JsonResponseCache');

(async () => {
    let time = 0, calls = 0, fail = false;
    const read = createJsonResponseCache(async () => {
        calls++;
        await Promise.resolve();
        if (fail) throw Error('database unavailable');
        return { payload: 'abc'.repeat(1000), calls };
    }, { now: () => time, ttlMs: 2000 });
    const [first, second] = await Promise.all([read(), read()]);
    assert.equal(calls, 1, 'concurrent tabs must share a single market build');
    assert.equal(first, second);
    assert.deepEqual(gunzipSync(first.zipped), first.json);
    assert.equal(await read(), first);
    time = 2000;
    fail = true;
    await assert.rejects(read(), /database unavailable/);
    fail = false;
    const refreshed = await read();
    assert.notEqual(refreshed.etag, first.etag, 'expiry and a failed build must permit retry');
    const response = () => ({ writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } });
    for (const encoding of ['gzip, deflate', 'gzip;q=0.0', 'identity']) {
        const r = response(); sendCachedJson({ headers: { 'accept-encoding': encoding } }, r, refreshed);
        assert.equal(r.status, 200);
        assert.equal(Boolean(r.headers['Content-Encoding']), encoding === 'gzip, deflate');
        assert.equal(r.headers.Vary, 'Accept-Encoding');
    }
    const r = response(); sendCachedJson({ headers: { 'if-none-match': refreshed.etag } }, r, refreshed);
    assert.equal(r.status, 304); assert.equal(r.body, undefined);
    console.log('Observer JSON cache checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
