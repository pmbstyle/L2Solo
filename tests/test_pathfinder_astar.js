// Initialize global environment
require('../src/Global');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

// Initialize geodata engine
GeodataEngine.init();

const blockX = 108;
const blockY = 114;

const buffer = GeodataEngine.getRegionBuffer(22, 24);
const offsetIndex = GeodataEngine.index_22_24;
if (!buffer || !offsetIndex) {
    console.log("SKIP: raw geodata region 22_24 is not available");
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
