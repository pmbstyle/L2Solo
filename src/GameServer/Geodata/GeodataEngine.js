const fs = require('fs');
const path = require('path');
const VirtualObstacles = invoke('GameServer/Geodata/VirtualObstacles/index');

const GeodataEngine = {
    regions: {}, // Loaded region buffers, keyed by "XX_YY"
    missing: {}, // Keys of missing regions, to prevent console spam and repeat disk checks

    init() {
        console.info("GeodataEngine :: Initializing...");
        VirtualObstacles.init();
        // Preload active regions on startup
        // NOTE: Giran (27_21), Elven Village (26_18), Orc Village (27_17),
        //       Dwarven Village (28_11) are beyond geodata coverage (max regionX=26).
        //       These cities will use fallback Z-height from current actor position.
        const activeRegions = [
            // Talking Island (x≈-84k, y≈244k)
            { x: 22, y: 24 }, // Talking Island Village (core)
            { x: 22, y: 23 }, // Talking Island (west)
            { x: 22, y: 25 }, // Talking Island (east)

            // Gludin (x≈-80k, y≈149k)
            { x: 22, y: 21 }, // Gludin Town (core)
            { x: 22, y: 20 }, // Gludin (south)
            { x: 22, y: 22 }, // Gludin (north)

            // Gludio (x≈-12k, y≈122k)
            { x: 24, y: 20 }, // Gludio Town (core)
            { x: 24, y: 19 }, // Gludio (south)
            { x: 24, y: 21 }, // Gludio (north)

            // Dion (x≈15k, y≈142k)
            { x: 25, y: 21 }, // Dion Town (core)
            { x: 25, y: 20 }, // Dion (south)

            // Dark Elven Village (x≈9k, y≈15k)
            { x: 25, y: 17 }, // Dark Elven Village (core)
            { x: 24, y: 17 }, // Dark Elven (west)
            { x: 25, y: 18 }, // Dark Elven (north)

            // Orc Village area (x≈84k — outside geodata coverage, but nearby regions)
            { x: 25, y: 16 }, // Orc Village adjacent area
            { x: 24, y: 16 }, // Orc Village adjacent area

            // Neutral Zone / Elven Forest (x≈-10k, y≈75k)
            { x: 24, y: 19 }, // Neutral Zone area (already loaded for Gludio south)

            // General world areas for pathfinding
            { x: 25, y: 19 }, // Central area
            { x: 24, y: 18 }, // Between cities
        ];
        activeRegions.forEach(reg => {
            this.loadRegion(reg.x, reg.y);
        });
    },

    loadRegion(regionX, regionY) {
        const key = `${regionX}_${regionY}`;
        if (this.missing[key]) {
            return false;
        }
        
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
            this.missing[key] = true;
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
            const cellZ = ((value & 0xFFF0) << 16) >> 17;
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
                const layerZ = ((value & 0xFFF0) << 16) >> 17;
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

    checkVirtualObstacles(x, y, regionKey) {
        return VirtualObstacles.checkObstacle(x, y, regionKey);
    },

    getCellData(x, y, z) {
        const regionX = (x >> 15) + 25;
        const regionY = (y >> 15) + 17;
        const regionKey = `${regionX}_${regionY}`;

        if (this.checkVirtualObstacles(x, y, regionKey)) {
            return { z: z, nswe: 0 }; // Fully blocked
        }

        const buffer = this.getRegionBuffer(regionX, regionY);
        if (!buffer) {
            return { z: z, nswe: 15 };
        }

        const localX = x - ((regionX - 25) << 15);
        const localY = y - ((regionY - 17) << 15);

        const blockX = localX >> 7;
        const blockY = localY >> 7;

        const cellX = (localX >> 4) & 7;
        const cellY = (localY >> 4) & 7;

        const key = `${regionX}_${regionY}`;
        const offsetIndex = this[`index_${key}`];
        if (!offsetIndex) {
            return { z: z, nswe: 15 };
        }

        const blockId = (blockX * 256) + blockY;
        const blockOffset = offsetIndex[blockId];
        if (blockOffset === undefined) {
            return { z: z, nswe: 15 };
        }

        const type = buffer.readUInt8(blockOffset);
        let cellOffset = blockOffset + 1;

        if (type === 0) {
            const flatZ = buffer.readInt16LE(cellOffset);
            return { z: flatZ, nswe: 15 };
        } else if (type === 1) {
            const cellId = (cellX * 8) + cellY;
            const value = buffer.readInt16LE(cellOffset + (cellId * 2));
            const cellZ = ((value & 0xFFF0) << 16) >> 17;
            const nswe = value & 0x000F;
            return { z: cellZ, nswe: nswe };
        } else if (type === 2) {
            const targetCellId = (cellX * 8) + cellY;
            let tempOffset = cellOffset;
            for (let i = 0; i < targetCellId; i++) {
                const layers = buffer.readUInt8(tempOffset);
                tempOffset += 1 + (layers * 2);
            }

            const layers = buffer.readUInt8(tempOffset);
            if (layers === 0) {
                return { z: z, nswe: 15 };
            }

            tempOffset += 1;
            let closestZ = z;
            let closestNswe = 15;
            let minDiff = Infinity;

            for (let l = 0; l < layers; l++) {
                const value = buffer.readInt16LE(tempOffset + (l * 2));
                const layerZ = ((value & 0xFFF0) << 16) >> 17;
                const diff = Math.abs(layerZ - z);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestZ = layerZ;
                    closestNswe = value & 0x000F;
                }
            }
            return { z: closestZ, nswe: closestNswe };
        }

        return { z: z, nswe: 15 };
    },

    hasLineOfSight(fromX, fromY, fromZ, toX, toY, toZ) {
        let cx = fromX >> 4;
        let cy = fromY >> 4;
        let cz = fromZ;

        const targetCx = toX >> 4;
        const targetCy = toY >> 4;

        if (cx === targetCx && cy === targetCy) {
            return true;
        }

        const dx = targetCx - cx;
        const dy = targetCy - cy;
        const steps = Math.max(Math.abs(dx), Math.abs(dy));

        const xInc = dx / steps;
        const yInc = dy / steps;

        let floatCx = cx;
        let floatCy = cy;

        for (let i = 0; i < steps; i++) {
            const nextCx = Math.round(floatCx + xInc);
            const nextCy = Math.round(floatCy + yInc);

            const diffX = nextCx - cx;
            const diffY = nextCy - cy;

            if (diffX !== 0 && diffY !== 0) {
                const cellCurr = this.getCellData((cx << 4) + 8, (cy << 4) + 8, cz);
                const cellHoriz = this.getCellData((nextCx << 4) + 8, (cy << 4) + 8, cz);
                const cellDiag = this.getCellData((nextCx << 4) + 8, (nextCy << 4) + 8, cellHoriz.z);

                let path1Passable = true;
                if (diffX > 0) {
                    path1Passable = path1Passable && ((cellCurr.nswe & 1) !== 0) && ((cellHoriz.nswe & 2) !== 0);
                } else {
                    path1Passable = path1Passable && ((cellCurr.nswe & 2) !== 0) && ((cellHoriz.nswe & 1) !== 0);
                }
                if (diffY > 0) {
                    path1Passable = path1Passable && ((cellHoriz.nswe & 4) !== 0) && ((cellDiag.nswe & 8) !== 0);
                } else {
                    path1Passable = path1Passable && ((cellHoriz.nswe & 8) !== 0) && ((cellDiag.nswe & 4) !== 0);
                }

                const cellVert = this.getCellData((cx << 4) + 8, (nextCy << 4) + 8, cz);
                let path2Passable = true;
                if (diffY > 0) {
                    path2Passable = path2Passable && ((cellCurr.nswe & 4) !== 0) && ((cellVert.nswe & 8) !== 0);
                } else {
                    path2Passable = path2Passable && ((cellCurr.nswe & 8) !== 0) && ((cellVert.nswe & 4) !== 0);
                }
                if (diffX > 0) {
                    path2Passable = path2Passable && ((cellVert.nswe & 1) !== 0) && ((cellDiag.nswe & 2) !== 0);
                } else {
                    path2Passable = path2Passable && ((cellVert.nswe & 2) !== 0) && ((cellDiag.nswe & 1) !== 0);
                }

                if (!path1Passable && !path2Passable) {
                    return false;
                }

                cz = cellDiag.z;
            } else {
                const cellCurr = this.getCellData((cx << 4) + 8, (cy << 4) + 8, cz);
                const cellNext = this.getCellData((nextCx << 4) + 8, (nextCy << 4) + 8, cz);

                if (Math.abs(cellNext.z - cellCurr.z) > 64) {
                    return false;
                }

                let passable = false;
                if (diffX > 0) {
                    passable = ((cellCurr.nswe & 1) !== 0) && ((cellNext.nswe & 2) !== 0);
                } else if (diffX < 0) {
                    passable = ((cellCurr.nswe & 2) !== 0) && ((cellNext.nswe & 1) !== 0);
                } else if (diffY > 0) {
                    passable = ((cellCurr.nswe & 4) !== 0) && ((cellNext.nswe & 8) !== 0);
                } else if (diffY < 0) {
                    passable = ((cellCurr.nswe & 8) !== 0) && ((cellNext.nswe & 4) !== 0);
                }

                if (!passable) {
                    return false;
                }

                cz = cellNext.z;
            }

            cx = nextCx;
            cy = nextCy;
            floatCx += xInc;
            floatCy += yInc;
        }

        return true;
    },

    findPath(startX, startY, startZ, endX, endY, endZ, maxNodes = 2000) {
        const startCx = startX >> 4;
        const startCy = startY >> 4;
        const endCx = endX >> 4;
        const endCy = endY >> 4;

        if (startCx === endCx && startCy === endCy) {
            return [{ locX: endX, locY: endY, locZ: endZ }];
        }

        const startNode = {
            cx: startCx,
            cy: startCy,
            cz: startZ,
            g: 0,
            h: (Math.abs(endCx - startCx) + Math.abs(endCy - startCy)) * 16,
            f: 0,
            parent: null
        };
        startNode.f = startNode.g + startNode.h;

        const openList = [startNode];
        const visited = new Set();
        visited.add(`${startCx},${startCy}`);

        let targetNode = null;
        let nodesExpanded = 0;

        while (openList.length > 0) {
            nodesExpanded++;
            if (nodesExpanded > maxNodes) {
                break;
            }

            const current = openList.shift();

            if (current.cx === endCx && current.cy === endCy) {
                targetNode = current;
                break;
            }

            const currentCell = this.getCellData((current.cx << 4) + 8, (current.cy << 4) + 8, current.cz);
            
            const directions = [
                { dx: 0, dy: -1, bit: 8, oppBit: 4 },
                { dx: 0, dy: 1, bit: 4, oppBit: 8 },
                { dx: 1, dy: 0, bit: 1, oppBit: 2 },
                { dx: -1, dy: 0, bit: 2, oppBit: 1 }
            ];

            for (const dir of directions) {
                const nCx = current.cx + dir.dx;
                const nCy = current.cy + dir.dy;
                const key = `${nCx},${nCy}`;

                if (visited.has(key)) {
                    continue;
                }

                if ((currentCell.nswe & dir.bit) === 0) {
                    continue;
                }

                const nCell = this.getCellData((nCx << 4) + 8, (nCy << 4) + 8, currentCell.z);

                if ((nCell.nswe & dir.oppBit) === 0) {
                    continue;
                }

                if (Math.abs(nCell.z - currentCell.z) > 64) {
                    continue;
                }

                const g = current.g + 16;
                const h = (Math.abs(endCx - nCx) + Math.abs(endCy - nCy)) * 16;
                const f = g + h;

                const neighbor = {
                    cx: nCx,
                    cy: nCy,
                    cz: nCell.z,
                    g: g,
                    h: h,
                    f: f,
                    parent: current
                };

                visited.add(key);

                let inserted = false;
                for (let i = 0; i < openList.length; i++) {
                    if (neighbor.f < openList[i].f) {
                        openList.splice(i, 0, neighbor);
                        inserted = true;
                        break;
                    }
                }
                if (!inserted) {
                    openList.push(neighbor);
                }
            }
        }
        
        // Debug pathfinder performance
        console.log(`findPath :: nodesExpanded = ${nodesExpanded}, targetNodeFound = ${!!targetNode}`);

        let node = targetNode;
        if (!node) {
            return null;
        }

        const pathPoints = [];
        while (node) {
            pathPoints.push({
                locX: (node.cx << 4) + 8,
                locY: (node.cy << 4) + 8,
                locZ: node.cz
            });
            node = node.parent;
        }
        pathPoints.reverse();

        const smoothedPath = [];
        if (pathPoints.length > 0) {
            smoothedPath.push(pathPoints[0]);
            let currentIdx = 0;

            while (currentIdx < pathPoints.length - 1) {
                let checkIdx = pathPoints.length - 1;
                while (checkIdx > currentIdx + 1) {
                    const startPt = pathPoints[currentIdx];
                    const endPt = pathPoints[checkIdx];
                    if (this.hasLineOfSight(startPt.locX, startPt.locY, startPt.locZ, endPt.locX, endPt.locY, endPt.locZ)) {
                        break;
                    }
                    checkIdx--;
                }
                smoothedPath.push(pathPoints[checkIdx]);
                currentIdx = checkIdx;
            }
        }

        if (smoothedPath.length > 0) {
            smoothedPath[smoothedPath.length - 1] = {
                locX: endX,
                locY: endY,
                locZ: endZ
            };
        }

        return smoothedPath;
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
