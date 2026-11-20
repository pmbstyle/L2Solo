// Tessera by Jagrat Patel (TheJagStudio), CC BY-NC 4.0.
const { monogramTokens } = require('./Monogram');

const SIZE = 16;
const HEIGHT = 12;
const PADDING = (SIZE - HEIGHT) / 2;
const PIXELS = SIZE * SIZE;
const COLORS = 512;
const MASK = BigInt(COLORS);
const VARIANTS = 4;
const BATCH = 2 * VARIANTS;
const STEPS = 16;
const GUIDANCE = 3;

function distribution(logits, conditional, unconditional, target, base) {
    let highest = -Infinity;
    for (let color = 0; color < COLORS; color += 1) {
        const background = logits[unconditional + color];
        const guided = background + GUIDANCE * (logits[conditional + color] - background);
        target[base + color] = guided;
        highest = Math.max(highest, guided);
    }
    let total = 0;
    for (let color = 0; color < COLORS; color += 1) {
        const weight = Math.exp(target[base + color] - highest);
        target[base + color] = weight;
        total += weight;
    }
    let draw = 1 - Math.random();
    let chosen = -1;
    for (let color = 0; color < COLORS; color += 1) {
        const probability = target[base + color] / total;
        target[base + color] = probability;
        if (draw > 0 && probability > 0) chosen = color;
        draw -= probability;
    }
    return chosen;
}

function selectPixels(candidates, fraction, remaining) {
    const noiseScale = 2 * (1 - fraction);
    const uncertain = new Float64Array(PIXELS).fill(-Infinity);
    for (const candidate of candidates) {
        const random = Math.max(1e-10, Math.random());
        candidate.score = Math.log(Math.max(candidate.probability, 1e-12)) - noiseScale * Math.log(-Math.log(random));
        if (candidate.probability < 0.9) uncertain[candidate.pixel] = candidate.score;
    }
    for (const candidate of candidates) {
        const { pixel, score, probability } = candidate;
        const x = pixel % SIZE;
        const y = Math.floor(pixel / SIZE);
        let bestNeighbor = -Infinity;
        for (let dy = Math.max(0, y - 1); dy <= Math.min(SIZE - 1, y + 1); dy += 1) {
            for (let dx = Math.max(0, x - 1); dx <= Math.min(SIZE - 1, x + 1); dx += 1) {
                bestNeighbor = Math.max(bestNeighbor, uncertain[dy * SIZE + dx]);
            }
        }
        candidate.priority = probability >= 0.9 || score >= bestNeighbor ? score + 1e4 : score;
    }
    candidates.sort((left, right) => right.priority - left.priority);
    return candidates.slice(0, Math.max(1, candidates.length - remaining));
}

async function sampleCrests(ort, session, text, pooled, palette, monogram, monogramColor) {
    const locked = monogramTokens(monogram, palette, SIZE, HEIGHT, monogramColor);
    const editablePixels = SIZE * HEIGHT - locked.size;
    const tokens = new BigInt64Array(BATCH * PIXELS);
    const textBatch = new Float32Array(BATCH * text.length);
    const pooledBatch = new Float32Array(BATCH * pooled.length);
    const remaining = new Float32Array(BATCH).fill(editablePixels / PIXELS);
    const probabilities = new Float32Array(BATCH * PIXELS * COLORS);
    const unconditional = new Uint8Array(BATCH).fill(1, VARIANTS);
    for (let row = 0; row < BATCH; row += 1) {
        const start = row * PIXELS + PADDING * SIZE;
        tokens.fill(MASK, start, start + SIZE * HEIGHT);
        // Known tokens stay fixed in both halves of the classifier-free guidance batch.
        for (const [pixel, token] of locked) tokens[start + pixel] = token;
        textBatch.set(text, row * text.length);
        pooledBatch.set(pooled, row * pooled.length);
    }
    const feeds = {
        pixels: new ort.Tensor('int64', tokens, [BATCH, PIXELS]),
        text: new ort.Tensor('float32', textBatch, [BATCH, 24, 512]),
        pooled: new ort.Tensor('float32', pooledBatch, [BATCH, 512]),
        ratio: new ort.Tensor('float32', remaining, [BATCH]),
        previous: new ort.Tensor('float32', probabilities, [BATCH, PIXELS, COLORS]),
        unconditional: new ort.Tensor('bool', unconditional, [BATCH])
    };
    for (let step = 1; step <= STEPS; step += 1) {
        const { logits } = await session.run(feeds);
        const fraction = step / STEPS;
        const target = Math.floor(editablePixels * Math.cos(Math.PI / 2 * fraction));
        for (let row = 0; row < VARIANTS; row += 1) {
            const offset = row * PIXELS;
            const other = (row + VARIANTS) * PIXELS;
            const candidates = [];
            for (let pixel = PADDING * SIZE; pixel < (SIZE - PADDING) * SIZE; pixel += 1) {
                if (tokens[offset + pixel] !== MASK) continue;
                const base = (offset + pixel) * COLORS;
                const mirror = (other + pixel) * COLORS;
                const color = distribution(logits.data, base, mirror, probabilities, base);
                probabilities.copyWithin(mirror, base, base + COLORS);
                candidates.push({ pixel, color, probability: probabilities[base + color] });
            }
            const committed = selectPixels(candidates, fraction, target);
            for (const { pixel, color } of committed) {
                tokens[offset + pixel] = BigInt(color);
                tokens[other + pixel] = BigInt(color);
            }
            remaining[row] = remaining[row + VARIANTS] = (candidates.length - committed.length) / PIXELS;
        }
    }

    return Array.from({ length: VARIANTS }, (_, row) => {
        const rgba = Buffer.alloc(SIZE * HEIGHT * 4, 255);
        for (let pixel = 0; pixel < SIZE * HEIGHT; pixel += 1) {
            const [r, g, b] = palette[Number(tokens[row * PIXELS + PADDING * SIZE + pixel])];
            rgba[pixel * 4] = r;
            rgba[pixel * 4 + 1] = g;
            rgba[pixel * 4 + 2] = b;
        }
        return rgba.toString('base64');
    });
}

module.exports = { sampleCrests, VARIANTS };
