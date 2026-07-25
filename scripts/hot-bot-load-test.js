#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, 'tmp', 'hot-load-tests');
const MAX_DIAGNOSTIC_OUTPUT_BYTES = 1024 * 1024;

function appendTail(value, chunk) {
    const next = `${value}${chunk}`;
    return next.length > MAX_DIAGNOSTIC_OUTPUT_BYTES ? next.slice(-MAX_DIAGNOSTIC_OUTPUT_BYTES) : next;
}

function parseArguments(argv) {
    const args = Object.fromEntries(argv
        .filter((value) => value.startsWith('--'))
        .map((value) => {
            const [key, raw = 'true'] = value.slice(2).split('=', 2);
            return [key, raw];
        }));
    const counts = String(args.counts || '50,100,200,300').split(',')
        .map(Number).filter((value) => Number.isInteger(value) && value > 0 && value <= 500);
    if (!counts.length) throw new Error('Use --counts=50,100,200,300 with values from 1 to 500.');
    const durationSeconds = Number(args.duration || 60);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 5 || durationSeconds > 1800) {
        throw new Error('Use --duration=<seconds> from 5 to 1800.');
    }
    const tickMs = Number(args.tick || 1000);
    if (!Number.isFinite(tickMs) || tickMs < 250 || tickMs > 10000) {
        throw new Error('Use --tick=<milliseconds> from 250 to 10000.');
    }
    const spreadMs = Number(args.spread || 100);
    if (!Number.isFinite(spreadMs) || spreadMs < 25 || spreadMs > tickMs) {
        throw new Error('Use --spread=<milliseconds> from 25 to the tick interval.');
    }
    return { counts, durationMs: Math.round(durationSeconds * 1000), tickMs, spreadMs };
}

function writeConfig(runId) {
    fs.mkdirSync(outputDir, { recursive: true });
    const databasePath = path.join(outputDir, `${runId}.sqlite`);
    const configPath = path.join(outputDir, `${runId}.ini`);
    fs.writeFileSync(configPath, [
        '[Database]',
        `path = ${path.relative(rootDir, databasePath).replace(/\\/g, '/')}`,
        '',
        '[AuthServer]',
        'port = 0',
        '',
        '[GameServer]',
        'port = 0',
        '',
        '[WorldObserver]',
        'enabled = false',
        '',
        '[BotPopulation]',
        'enabled = false'
    ].join('\n'), 'utf8');
    return { configPath, databasePath };
}

function runScenario(count, settings, sequence) {
    const runId = `hot-${count}-${Date.now()}-${sequence}`;
    const files = writeConfig(runId);
    const args = ['--openssl-legacy-provider', 'src/NodeL2'];
    const environment = {
        ...process.env,
        L2NODE_CONFIG_FILE: files.configPath,
        L2NODE_HOT_LOAD_TEST: '1',
        L2NODE_HOT_LOAD_COUNT: String(count),
        L2NODE_HOT_LOAD_DURATION_MS: String(settings.durationMs),
        L2NODE_HOT_LOAD_TICK_MS: String(settings.tickMs),
        L2NODE_HOT_LOAD_SPREAD_MS: String(settings.spreadMs),
        L2NODE_HOT_LOAD_PROVISION_TIMEOUT_MS: String(Math.max(120000, count * 700)),
        BOT_POPULATION_ENABLED: '0',
        BOT_STATUS_LOGS: '0',
        NODEL2_DEV_CONSOLE: '0'
    };

    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: rootDir, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let errorOutput = '';
        let stdoutBuffer = '';
        let result = null;
        let parseError = null;
        const consumeLine = (line) => {
            if (line.startsWith('HotLoad') || line.startsWith('HOT_LOAD_RESULT')) {
                process.stdout.write(`${line}\n`);
            }
            if (!line.startsWith('HOT_LOAD_RESULT ')) return;
            try {
                result = JSON.parse(line.slice('HOT_LOAD_RESULT '.length));
            } catch (error) {
                parseError = error;
            }
        };
        child.stdout.on('data', (chunk) => {
            const text = String(chunk);
            output = appendTail(output, text);
            stdoutBuffer += text;
            let newlineIndex;
            while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
                consumeLine(stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, ''));
                stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            }
        });
        child.stderr.on('data', (chunk) => {
            errorOutput = appendTail(errorOutput, String(chunk));
            process.stderr.write(chunk);
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (stdoutBuffer) consumeLine(stdoutBuffer.replace(/\r$/, ''));
            if (result) {
                resolve({ ...result, files, exitCode: code || 0 });
                return;
            }
            if (parseError) {
                reject(new Error(`load scenario ${count} emitted invalid result JSON: ${parseError.message}`));
                return;
            }
            reject(new Error(`load scenario ${count} exited ${code}: ${(errorOutput || output).slice(-1200)}`));
        });
    });
}

async function main() {
    const settings = parseArguments(process.argv.slice(2));
    const results = [];
    for (const [index, count] of settings.counts.entries()) {
        results.push(await runScenario(count, settings, index));
    }
    const summaryPath = path.join(outputDir, `summary-${Date.now()}.json`);
    fs.writeFileSync(summaryPath, `${JSON.stringify({ settings, results }, null, 2)}\n`, 'utf8');
    process.stdout.write(`HOT_LOAD_SUMMARY ${JSON.stringify({ summaryPath, results })}\n`);
    if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`Hot load test failed: ${error.stack || error}\n`);
        process.exitCode = 1;
    });
}

module.exports = { parseArguments, writeConfig, appendTail };
