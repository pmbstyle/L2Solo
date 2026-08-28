const fs = require('fs');
const path = require('path');

function pointInPolygon(x, y, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const xi = points[i][0];
        const yi = points[i][1];
        const xj = points[j][0];
        const yj = points[j][1];
        const intersects = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1) + xi);
        if (intersects) inside = !inside;
    }
    return inside;
}

const VirtualObstacles = {
    obstaclesByRegion: {},

    init() {
        this.obstaclesByRegion = {};
        const files = fs.readdirSync(__dirname);
        
        for (const file of files) {
            if (file === 'index.js' || !file.endsWith('.js')) {
                continue;
            }
            try {
                const loc = require(path.join(__dirname, file));
                if (loc && loc.region) {
                    if (!this.obstaclesByRegion[loc.region]) {
                        this.obstaclesByRegion[loc.region] = [];
                    }
                    this.obstaclesByRegion[loc.region].push(loc);
                    utils.infoSuccess("GeodataEngine", "Loaded virtual obstacles for %s (Region: %s)", loc.name || file, loc.region);
                }
            } catch (err) {
                console.error(`VirtualObstacles :: Failed to load ${file}:`, err);
            }
        }
    },

    checkObstacle(x, y, regionKey) {
        const locations = this.obstaclesByRegion[regionKey];
        if (!locations) {
            return false;
        }

        for (let i = 0; i < locations.length; i++) {
            const loc = locations[i];

            // 1. Check buildings
            if (loc.buildings) {
                for (let j = 0; j < loc.buildings.length; j++) {
                    const b = loc.buildings[j];
                    if (b.type === 'circle') {
                        const dx = x - b.x;
                        const dy = y - b.y;
                        if (dx * dx + dy * dy < b.r * b.r) {
                            return true;
                        }
                    } else if (b.type === 'polygon' && Array.isArray(b.points) && b.points.length >= 3) {
                        if (pointInPolygon(x, y, b.points)) {
                            return true;
                        }
                    } else if (b.type === 'box_door') {
                        if (Math.abs(y - b.minY) < 64 && x >= b.minX && x <= b.maxX) {
                            if (b.doorWall === 'N' && x >= b.doorMin && x <= b.doorMax) continue;
                            return true;
                        }
                        if (Math.abs(y - b.maxY) < 64 && x >= b.minX && x <= b.maxX) {
                            if (b.doorWall === 'S' && x >= b.doorMin && x <= b.doorMax) continue;
                            return true;
                        }
                        if (Math.abs(x - b.minX) < 64 && y >= b.minY && y <= b.maxY) {
                            if (b.doorWall === 'W' && y >= b.doorMin && y <= b.doorMax) continue;
                            return true;
                        }
                        if (Math.abs(x - b.maxX) < 64 && y >= b.minY && y <= b.maxY) {
                            if (b.doorWall === 'E' && y >= b.doorMin && y <= b.doorMax) continue;
                            return true;
                        }
                    }
                }
            }

            // 2. Check walls
            if (loc.walls) {
                for (let j = 0; j < loc.walls.length; j++) {
                    const w = loc.walls[j];
                    if (w.type === 'horizontal') {
                        if (Math.abs(y - w.y) < 80 && x >= w.minX && x <= w.maxX) {
                            if (Math.abs(x - w.gateX) > (w.gateWidth / 2)) {
                                return true;
                            }
                        }
                    } else if (w.type === 'vertical') {
                        if (Math.abs(x - w.x) < 80 && y >= w.minY && y <= w.maxY) {
                            if (Math.abs(y - w.gateY) > (w.gateWidth / 2)) {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        return false;
    }
};

module.exports = VirtualObstacles;
