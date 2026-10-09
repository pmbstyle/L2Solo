const { gzip } = require('node:zlib');
const { promisify } = require('node:util');
const compress = promisify(gzip);

// One bounded entry per endpoint; overlapping tabs share both the build and
// serialization. Failed builds never replace a successful value with emptiness.
function createJsonResponseCache(load, { ttlMs = 2000, now = Date.now } = {}) {
    let cached = null, inFlight = null, revision = 0;
    return async function read() {
        if (cached && now() - cached.at < ttlMs) return cached;
        if (inFlight) return inFlight;
        inFlight = (async () => {
            const json = Buffer.from(JSON.stringify(await load()));
            const zipped = await compress(json);
            const entry = { json, zipped, at: now(), etag: `W/"market-${++revision}-${json.length}"` };
            cached = entry;
            return entry;
        })();
        try { return await inFlight; } finally { inFlight = null; }
    };
}

function sendCachedJson(request, response, entry) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache',
        Vary: 'Accept-Encoding', ETag: entry.etag };
    if (request.headers['if-none-match'] === entry.etag) {
        response.writeHead(304, headers); response.end(); return;
    }
    const acceptsGzip = String(request.headers['accept-encoding'] || '').split(',').some(value => {
        const [encoding, ...options] = value.trim().split(';');
        return encoding.toLowerCase() === 'gzip' && !options.some(option => /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(option));
    });
    const body = acceptsGzip ? entry.zipped : entry.json;
    if (acceptsGzip) headers['Content-Encoding'] = 'gzip';
    response.writeHead(200, { ...headers, 'Content-Length': body.length });
    response.end(body);
}

module.exports = { createJsonResponseCache, sendCachedJson };
