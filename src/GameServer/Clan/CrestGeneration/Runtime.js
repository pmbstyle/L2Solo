const path = require('node:path');
const { execFile, fork } = require('node:child_process');
const { promisify } = require('node:util');
const { MODEL_VERSION, prepareModelFiles } = require('./ModelFiles');
const { normalizeMonogram, normalizeMonogramColor } = require('./Monogram');

const DIRECTORY = path.resolve(__dirname, '../../../../.l2solo/models', MODEL_VERSION);
const PROMPT_LIMIT = 120;
const INFERENCE_TIMEOUT_MS = 120_000;
const KEEP_WARM_MS = 60_000;
const run = promisify(execFile);

let assets;
let downloading;
let child;
let idleTimer;
let busy = false;
let stopped = false;

function enabled() {
    return options.default.ClanSimulation?.localCrestGenerationEnabled === true;
}

async function checkInferenceRuntime(signal) {
    try {
        // Load only the native binding in a short-lived process before downloading the model.
        const binding = require.resolve('onnxruntime-node');
        await run(process.execPath, ['-e', 'require(process.argv[1])', binding], { signal, timeout: 10_000, windowsHide: true });
    } catch (cause) {
        signal.throwIfAborted();
        const error = new Error(cause.message, { cause });
        error.code = 'crest_runtime_unavailable';
        throw error;
    }
}

function prepare() {
    if (!assets) {
        downloading = new AbortController();
        const { signal } = downloading;
        assets = checkInferenceRuntime(signal).then(() => prepareModelFiles(DIRECTORY, signal, (file) => {
            utils.infoSuccess('ClanCrest', 'downloading %s from l2solo.com', file);
        })).catch((error) => {
            assets = null;
            if (!stopped) utils.infoWarn('ClanCrest', 'model preparation failed: %s', error.message);
            throw error;
        }).finally(() => { downloading = null; });
    }
    return assets;
}

function warmup() {
    if (enabled() && !stopped) prepare().catch(() => {});
}

function unload() {
    clearTimeout(idleTimer);
    child?.kill();
    child = null;
}

function inferenceProcess() {
    if (child) return child;
    const process = fork(path.join(__dirname, 'InferenceProcess.js'), [DIRECTORY], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], windowsHide: true
    });
    child = process;
    const forget = () => { if (child === process) child = null; };
    process.once('error', forget);
    process.once('exit', forget);
    return process;
}

function infer(prompt, monogram, monogramColor) {
    clearTimeout(idleTimer);
    const worker = inferenceProcess();
    return new Promise((resolve, reject) => {
        const finish = (error, result) => {
            clearTimeout(timeout);
            worker.off('error', onError);
            worker.off('exit', onExit);
            worker.off('message', onMessage);
            if (error) reject(error);
            else resolve(result);
        };
        const onError = (error) => finish(error);
        const onExit = (code) => finish(new Error(`Inference process exited (${code})`));
        const onMessage = (result) => finish(null, result);
        const timeout = setTimeout(() => finish(new Error('Inference timed out')), INFERENCE_TIMEOUT_MS);
        worker.once('error', onError);
        worker.once('exit', onExit);
        worker.once('message', onMessage);
        worker.send({ prompt, monogram, monogramColor }, (error) => { if (error) finish(error); });
    });
}

async function generate(value, letter, color) {
    if (!enabled() || stopped) return { ok: false, code: 'crest_generation_disabled' };
    const prompt = typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : '';
    if (!prompt || prompt.length > PROMPT_LIMIT) return { ok: false, code: 'invalid_crest_prompt' };
    const monogram = normalizeMonogram(letter);
    if (monogram === null) return { ok: false, code: 'invalid_crest_monogram' };
    const monogramColor = normalizeMonogramColor(color);
    if (monogramColor === null) return { ok: false, code: 'invalid_crest_monogram_color' };
    if (busy) return { ok: false, code: 'crest_generation_busy' };
    busy = true;
    try {
        try { await prepare(); }
        catch (error) {
            if (stopped) return { ok: false, code: 'crest_generation_disabled' };
            if (error.code !== 'crest_runtime_unavailable') return { ok: false, code: 'crest_model_unavailable' };
            return { ok: false, code: error.code, error: process.platform === 'win32'
                ? 'ONNX Runtime could not load on the server. Check the server console and install the Microsoft Visual C++ Redistributable if it is missing.'
                : 'ONNX Runtime could not load on the server. Check the server console and the server dependencies.' };
        }
        if (stopped) return { ok: false, code: 'crest_generation_disabled' };
        const result = await infer(prompt, monogram, monogramColor);
        if (result.code === 'crest_generation_failed') throw new Error(result.detail);
        return result;
    } catch (error) {
        unload();
        if (!stopped) utils.infoWarn('ClanCrest', 'generation failed: %s', error.message);
        return { ok: false, code: 'crest_generation_failed' };
    } finally {
        busy = false;
        if (child) idleTimer = setTimeout(unload, KEEP_WARM_MS).unref();
    }
}

function stop() {
    stopped = true;
    downloading?.abort();
    unload();
}

module.exports = { enabled, warmup, generate, stop };
