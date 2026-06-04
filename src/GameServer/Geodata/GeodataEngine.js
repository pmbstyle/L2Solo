const fs = require('fs');
const path = require('path');

const GeodataEngine = {
    regions: {}, // Loaded region buffers, keyed by "XX_YY"

    init() {
        console.info("GeodataEngine :: Initializing...");
        // Auto-load Talking Island region 22_24
        this.loadRegion(22, 24);
    },

    loadRegion(regionX, regionY) {
        const key = `${regionX}_${regionY}`;
        // Adjust path to find the Geodata directory under data/Geodata/
        const filePath = path.join(__dirname, `../../../data/Geodata/${key}.l2j`);
        
        if (fs.existsSync(filePath)) {
            try {
                const buffer = fs.readFileSync(filePath);
                this.regions[key] = buffer;
                
                // Build block offset index table
                const offsetIndex = this.buildOffsetIndex(buffer);
                this[`index_${key}`] = offsetIndex;

                utils.infoSuccess("GeodataEngine", "Loaded region geodata: %s (Size: %s MB)", key, (buffer.length / (1024 * 1024)).toFixed(2));
                return true;
            } catch (err) {
                console.error(`GeodataEngine :: Failed to load region ${key}:`, err);
            }
        } else {
            utils.infoWarn("GeodataEngine", "Geodata file not found: %s", filePath);
        }
        return false;
    },

    getRegionBuffer(regionX, regionY) {
        const key = `${regionX}_${regionY}`;
        if (this.regions[key]) {
            return this.regions[key];
        }
        // Try to load dynamically
        if (this.loadRegion(regionX, regionY)) {
            return this.regions[key];
        }
        return null;
    },

    getHeight(x, y, z) {
        // Lineage 2 coordinate scaling region formula
        const regionX = (x >> 15) + 25;
        const regionY = (y >> 15) + 17;

        const buffer = this.getRegionBuffer(regionX, regionY);
        if (!buffer) {
            return z; // Fallback to current Z height if region geodata is not loaded
        }

        // Calculate local coordinates inside the region (0 to 32767)
        const localX = x - ((regionX - 25) << 15);
        const localY = y - ((regionY - 17) << 15);

        // Calculate block index inside the region (0 to 255)
        const blockX = localX >> 7;
        const blockY = localY >> 7;

        // Calculate cell index inside the block (0 to 7)
        const cellX = (localX >> 4) & 7;
        const cellY = (localY >> 4) & 7;

        const key = `${regionX}_${regionY}`;
        const offsetIndex = this[`index_${key}`];
        if (!offsetIndex) {
            return z;
        }

        const blockId = (blockX * 256) + blockY;
        const blockOffset = offsetIndex[blockId];
        if (blockOffset === undefined) {
            return z;
        }

        // Read block type (1 byte)
        const type = buffer.readUInt8(blockOffset);
        let cellOffset = blockOffset + 1;

        if (type === 0) { // FLAT
            const flatZ = buffer.readInt16LE(cellOffset);
            return flatZ;
        } else if (type === 1) { // COMPLEX
            const cellId = (cellX * 8) + cellY;
            const value = buffer.readInt16LE(cellOffset + (cellId * 2));
            const cellZ = (value & 0xFFF0) >> 1;
            return cellZ;
        } else if (type === 2) { // MULTILEVEL
            const targetCellId = (cellX * 8) + cellY;
            let tempOffset = cellOffset;
            for (let i = 0; i < targetCellId; i++) {
                const layers = buffer.readUInt8(tempOffset);
                tempOffset += 1 + (layers * 2);
            }

            const layers = buffer.readUInt8(tempOffset);
            if (layers === 0) {
                return z;
            }

            tempOffset += 1;
            // Scan layers to find the one closest to current Z-height
            let closestZ = z;
            let minDiff = Infinity;

            for (let l = 0; l < layers; l++) {
                const value = buffer.readInt16LE(tempOffset + (l * 2));
                const layerZ = (value & 0xFFF0) >> 1;
                const diff = Math.abs(layerZ - z);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestZ = layerZ;
                }
            }
            return closestZ;
        }

        return z;
    },

    buildOffsetIndex(buffer) {
        const index = new Int32Array(256 * 256);
        let offset = 0;
        let blockCount = 0;
        const totalBlocks = 256 * 256;

        while (offset < buffer.length && blockCount < totalBlocks) {
            index[blockCount] = offset;
            const type = buffer.readUInt8(offset);
            offset += 1;

            if (type === 0) {
                offset += 2;
            } else if (type === 1) {
                offset += 128;
            } else if (type === 2) {
                for (let i = 0; i < 64; i++) {
                    const layers = buffer.readUInt8(offset);
                    offset += 1 + (layers * 2);
                }
            }
            blockCount++;
        }
        return index;
    }
};

module.exports = GeodataEngine;
