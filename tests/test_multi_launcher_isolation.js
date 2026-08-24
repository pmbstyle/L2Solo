const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
    ensureInstanceFiles,
    environmentFor,
    INSTANCE_DEFINITIONS
} = require('../scripts/run-simulations');

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

function request(port, pathname) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: pathname }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                if (response.statusCode !== 200) {
                    reject(new Error(body || `HTTP ${response.statusCode}`));
                    return;
                }
                resolve(JSON.parse(body));
            });
        }).on('error', reject);
    });
}

async function waitForStatus(port) {
    let lastError = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            return await request(port, '/api/status');
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    throw lastError || new Error('launcher did not start');
}

function stopLauncher(child) {
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill();
        setTimeout(resolve, 2000).unref();
    });
}

(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2node-multi-launcher-'));
    const ports = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
    const definitions = INSTANCE_DEFINITIONS.slice(0, 2).map((definition, index) => ({
        ...definition,
        launcherPort: ports[index],
        observerPort: ports[index + 2]
    }));
    const children = [];

    try {
        const instanceStates = definitions.map((definition) => {
            const files = ensureInstanceFiles(definition, tmpDir);
            const environment = environmentFor(definition, files, { noBrowser: true });
            const child = spawn(process.execPath, [path.join('scripts', 'start.js')], {
                cwd: path.resolve(__dirname, '..'),
                env: environment,
                stdio: 'ignore'
            });
            children.push(child);
            return { definition, files };
        });

        const statuses = await Promise.all(instanceStates.map(({ definition }) => waitForStatus(definition.launcherPort)));
        assert.notStrictEqual(instanceStates[0].files.configPath, instanceStates[1].files.configPath);
        assert.notStrictEqual(instanceStates[0].files.databasePath, instanceStates[1].files.databasePath);
        assert.match(fs.readFileSync(instanceStates[0].files.configPath, 'utf8'), /port = 2111/);
        assert.match(fs.readFileSync(instanceStates[1].files.configPath, 'utf8'), /port = 2112/);

        statuses.forEach((status, index) => {
            const { definition, files } = instanceStates[index];
            assert.strictEqual(status.phase, 'stopped');
            assert.strictEqual(status.launcherUrl, `http://127.0.0.1:${definition.launcherPort}/`);
            assert.strictEqual(status.mapUrl, `http://127.0.0.1:${definition.observerPort}/observer/`);
            assert.strictEqual(status.logFilePath, path.join(files.runtimeDir, 'logs', 'latest-server.log'));
        });
    } finally {
        await Promise.all(children.map(stopLauncher));
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log('multi-launcher isolation ok');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
