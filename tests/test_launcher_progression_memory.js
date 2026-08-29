const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function request(port, method, pathname, payload) {
    return new Promise((resolve, reject) => {
        const body = payload ? JSON.stringify(payload) : '';
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: pathname,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(data || `HTTP ${res.statusCode}`));
                    return;
                }

                resolve(data ? JSON.parse(data) : {});
            });
        });

        req.on('error', reject);
        req.end(body);
    });
}

function requestFailure(port, method, pathname, payload) {
    return request(port, method, pathname, payload)
        .then(() => { throw new Error('expected request to fail'); })
        .catch((error) => error);
}

function requestText(port, pathname) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: pathname }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(data || `HTTP ${res.statusCode}`));
                    return;
                }
                resolve(data);
            });
        }).on('error', reject);
    });
}

async function waitForStatus(port) {
    let lastError = null;

    for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
            return await request(port, 'GET', '/api/status');
        } catch (err) {
            lastError = err;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    throw lastError || new Error('launcher did not start');
}

function startLauncher(port, settingsPath, configPath = null) {
    const env = {
        ...process.env,
        L2NODE_LAUNCHER_PORT: String(port),
        L2NODE_LAUNCHER_SETTINGS_FILE: settingsPath,
        L2NODE_NO_BROWSER: '1'
    };
    delete env.L2NODE_PROGRESSION_RATE;
    delete env.L2NODE_SHARED_CONFIG_FILE;
    delete env.L2NODE_AI_API_URL;
    delete env.L2NODE_AI_API_KEY;
    delete env.L2NODE_AI_MODEL;
    delete env.OPENROUTER_API_URL;
    delete env.OPENROUTER_API_KEY;
    delete env.OPENROUTER_MODEL;
    if (configPath) env.L2NODE_CONFIG_FILE = configPath;
    else delete env.L2NODE_CONFIG_FILE;

    return spawn(process.execPath, [path.join('scripts', 'start.js')], {
        cwd: path.resolve(__dirname, '..'),
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

async function stopLauncher(child) {
    if (!child || child.exitCode !== null) {
        return;
    }

    await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill();
        setTimeout(resolve, 2000).unref();
    });
}

(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2node-launcher-'));
    const settingsPath = path.join(tmpDir, 'settings.json');
    const configPath = path.join(tmpDir, 'llm.ini');
    const port = await freePort();
    const modelPort = await freePort();
    let child = null;
    let modelMode = 'success';
    let lastModelRequest = null;
    const modelServer = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            lastModelRequest = {
                url: req.url,
                authorization: req.headers.authorization,
                body: body ? JSON.parse(body) : null
            };
            res.setHeader('Content-Type', 'application/json');
            if (modelMode === 'error') {
                res.statusCode = 503;
                res.end(JSON.stringify({ error: { message: 'model not loaded' } }));
                return;
            }
            res.end(JSON.stringify({
                id: 'launcher-test',
                choices: [{ message: { role: 'assistant', content: 'L2SOLO_LLM_OK' }, finish_reason: 'stop' }]
            }));
        });
    });

    try {
        await new Promise((resolve, reject) => {
            modelServer.once('error', reject);
            modelServer.listen(modelPort, '127.0.0.1', resolve);
        });
        child = startLauncher(port, settingsPath);
        let status = await waitForStatus(port);
        assert.strictEqual(status.progressionRate, 'x1');

        const launcherHtml = await requestText(port, '/');
        assert.match(launcherHtml, /<details class="wipe-panel">/);
        assert.match(launcherHtml, /<div class="wipe-content">/);
        assert.match(launcherHtml, /logAutoScroll/);
        assert.match(launcherHtml, /id="llmPanel"/);
        assert.match(launcherHtml, /id="llmTest"/);
        assert.match(launcherHtml, /Test inference/);

        const confirmationError = await requestFailure(port, 'POST', '/api/wipe', { scope: 'bots', confirmation: 'wipe bots' });
        assert.match(confirmationError.message, /Type WIPE BOTS/);

        status = await request(port, 'POST', '/api/progression-rate', { progressionRate: 'x50' });
        assert.strictEqual(status.progressionRate, 'x50');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { progressionRate: 'x50' });

        await stopLauncher(child);
        child = startLauncher(port, settingsPath);
        status = await waitForStatus(port);
        assert.strictEqual(status.progressionRate, 'x50');

        await stopLauncher(child);
        fs.writeFileSync(configPath, [
            '[AI]',
            'enabled = true',
            `apiUrl = http://127.0.0.1:${modelPort}/v1/chat/completions?private=hidden`,
            'apiKey = local-test-key',
            'model = local-test-model',
            'reasoningEffort = off',
            ''
        ].join('\n'));
        child = startLauncher(port, settingsPath, configPath);
        status = await waitForStatus(port);
        assert.strictEqual(status.llm.enabled, true);
        assert.strictEqual(status.llm.phase, 'untested');
        assert.strictEqual(status.llm.model, 'local-test-model');
        assert.strictEqual(status.llm.endpoint, `http://127.0.0.1:${modelPort}/v1/chat/completions`);
        assert.doesNotMatch(JSON.stringify(status), /local-test-key|private=hidden/);

        status = await request(port, 'POST', '/api/llm/test');
        assert.strictEqual(status.llm.phase, 'online');
        assert.match(status.llm.message, /Inference responded successfully/);
        assert.strictEqual(lastModelRequest.url, '/v1/chat/completions?private=hidden');
        assert.strictEqual(lastModelRequest.authorization, 'Bearer local-test-key');
        assert.strictEqual(lastModelRequest.body.model, 'local-test-model');
        assert.strictEqual(lastModelRequest.body.reasoning_effort, 'none');
        assert.strictEqual(lastModelRequest.body.max_tokens, 128);

        modelMode = 'error';
        status = await request(port, 'POST', '/api/llm/test');
        assert.strictEqual(status.llm.phase, 'error');
        assert.match(status.llm.message, /HTTP 503: model not loaded/);

        fs.writeFileSync(configPath, [
            '[AI]',
            'enabled = true',
            `apiUrl = http://127.0.0.1:${modelPort}/v1/chat/completions`,
            'model =',
            ''
        ].join('\n'));
        status = await request(port, 'GET', '/api/status');
        assert.strictEqual(status.llm.phase, 'error');
        assert.match(status.llm.message, /model is empty/);
    } finally {
        await stopLauncher(child);
        await new Promise((resolve) => modelServer.close(resolve));
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log('launcher progression memory ok');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
