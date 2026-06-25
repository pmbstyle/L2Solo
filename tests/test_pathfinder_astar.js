// Initialize global environment
require('../src/Global');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

// Initialize geodata engine
GeodataEngine.init();

const sampleX = -84108;
const sampleY = 244604;
const regionX = (sampleX >> 15) + 20;
const regionY = (sampleY >> 15) + 18;
const localX = sampleX - ((regionX - 20) << 15);
const localY = sampleY - ((regionY - 18) << 15);
const blockX = localX >> 7;
const blockY = localY >> 7;
const regionKey = `${regionX}_${regionY}`;

const buffer = GeodataEngine.getRegionBuffer(regionX, regionY);
const offsetIndex = GeodataEngine[`index_${regionKey}`];
if (!buffer || !offsetIndex) {
    console.log(`SKIP: raw geodata region ${regionKey} is not available`);
    process.exit(0);
}

const blockOffset = offsetIndex[(blockX * 256) + blockY];
if (blockOffset === undefined) {
    console.log(`SKIP: raw geodata block ${blockX},${blockY} is not indexed`);
    process.exit(0);
}

const type = buffer.readUInt8(blockOffset);

console.log(`Block ${blockX},${blockY} offset: ${blockOffset}, Type: ${type}`);

if (type === 1) {
    let cellOffset = blockOffset + 1;
    for (let cx = 0; cx < 8; cx++) {
        let row = "";
        for (let cy = 0; cy < 8; cy++) {
            const cellId = (cx * 8) + cy;
            const value = buffer.readInt16LE(cellOffset + (cellId * 2));
            const nswe = value & 0x000F;
            const z = ((value & 0xFFF0) << 16) >> 17;
            row += `[Z:${z}, N:${nswe}] `;
        }
        console.log(row);
    }
}
