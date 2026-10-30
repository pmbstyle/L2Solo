require('../src/Global');
const assert = require('assert');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

const cases = [
    ['Talking Island', -84108, 244604, '17_25'],
    ['Gludin', -80752, 149776, '17_22'],
    ['Gludio', -12736, 122816, '19_21'],
    ['Dion', 15631, 142885, '20_22'],
    ['Oren', 82960, 53177, '22_19'],
    ['Giran', 113845, 144186, '23_22'],
    ['Aden', 147450, 26741, '24_18'],
    ['Dwarven Village', 116226, -178529, '23_12'],
    ['Antharas', 185708, 114298, '25_21']
];

for (const [name, x, y, expected] of cases) {
    assert.strictEqual(GeodataEngine.getRegionKey(x, y), expected, name);
}

(async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const { Worker } = require('worker_threads');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-geodata-directory-'));
    const selected = path.join(root, 'selected'), decoy = path.join(root, 'decoy');
    const originalDirectory = process.env.L2NODE_GEODATA_DIR;
    let worker;
    try {
        for (const [directory, height] of [[selected, 120], [decoy, 512]]) {
            fs.mkdirSync(directory);
            const region = Buffer.alloc(256 * 256 * 3);
            for (let offset = 0; offset < region.length; offset += 3) region.writeInt16LE(height, offset + 1);
            fs.writeFileSync(path.join(directory, '17_25.l2j'), region);
        }
        process.env.L2NODE_GEODATA_DIR = selected;
        const descriptor = GeodataEngine.sharedDescriptor();
        assert.strictEqual(descriptor.directory, selected);
        process.env.L2NODE_GEODATA_DIR = decoy;
        assert.strictEqual(GeodataEngine.getGeodataDir(), selected,
            'an existing catalog must retain its selected directory until restart');
        assert.strictEqual(GeodataEngine.getHeight(-84108, 244604, 0), 120);
        worker = new Worker(`
            const { parentPort, workerData } = require('worker_threads');
            require(workerData.globalPath);
            const geo = invoke('GameServer/Geodata/GeodataEngine');
            geo.attachShared(workerData.descriptor);
            parentPort.postMessage({ directory: geo.getGeodataDir(),
                height: geo.getHeight(-84108, 244604, 0), regions: geo.sharedDescriptor().regions.length });
        `, { eval: true, workerData: { descriptor, globalPath: path.resolve(__dirname, '../src/Global.js') },
            env: { ...process.env, L2NODE_GEODATA_DIR: decoy } });
        const answer = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
        assert.deepStrictEqual(answer, { directory: selected, height: 120, regions: 1 },
            'workers must use the main thread catalog even when their environment points elsewhere');
        console.log('Geodata region mapping, external directory and shared worker checks passed');
    } finally {
        await worker?.terminate();
        if (originalDirectory === undefined) delete process.env.L2NODE_GEODATA_DIR;
        else process.env.L2NODE_GEODATA_DIR = originalDirectory;
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
