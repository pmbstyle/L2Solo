const fs = require('node:fs/promises');
const path = require('node:path');
const { Tokenizer } = require('@huggingface/tokenizers');
const { sampleCrests } = require('./TesseraSampler');

const TEXT_LENGTH = 24;
const END_TOKEN = 49407n;

async function load(directory) {
    const ort = require('onnxruntime-node');
    const read = async (name) => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
    const tokenizer = new Tokenizer(await read('tokenizer.json'), await read('tokenizer_config.json'));
    const palette = await read('palette.json');
    const options = { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1 };
    const clip = await ort.InferenceSession.create(path.join(directory, 'clip.onnx'), options);
    try {
        const tessera = await ort.InferenceSession.create(path.join(directory, 'tessera.onnx'), options);
        return { ort, tokenizer, clip, tessera, palette };
    } catch (error) {
        await clip.release();
        throw error;
    }
}

async function generate(runtime, { prompt, monogram, monogramColor }) {
    const { ort, tokenizer, clip, tessera, palette } = runtime;
    const { ids } = tokenizer.encode(`pixel art crest, ${prompt}`);
    if (ids.length > TEXT_LENGTH) return { ok: false, code: 'crest_prompt_too_long' };
    const padded = new BigInt64Array(TEXT_LENGTH).fill(END_TOKEN);
    padded.set(BigInt64Array.from(ids, BigInt));
    const { text, pooled } = await clip.run({ ids: new ort.Tensor('int64', padded, [1, TEXT_LENGTH]) });
    return { ok: true, pixels: await sampleCrests(ort, tessera, text.data, pooled.data, palette, monogram, monogramColor) };
}

let runtime;
let pending;
async function respond(request) {
    let result;
    try {
        runtime ||= await load(process.argv[2]);
        result = await generate(runtime, request);
    } catch (error) {
        result = { ok: false, code: 'crest_generation_failed', detail: error.message };
    }
    if (process.connected) process.send(result, () => {});
}

process.on('message', (request) => { pending = respond(request); });
process.once('disconnect', async () => {
    await pending;
    await runtime?.tessera.release();
    await runtime?.clip.release();
});
