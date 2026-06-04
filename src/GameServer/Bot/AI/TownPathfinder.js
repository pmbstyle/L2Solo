const GATES = {
    NORTH: {
        gate: { locX: -84081, locY: 243227, locZ: -3723 },
        approach: { locX: -84081, locY: 242827, locZ: -3723 }
    },
    WEST: {
        gate: { locX: -85400, locY: 244579, locZ: -3730 },
        approach: { locX: -85800, locY: 244579, locZ: -3730 }
    },
    EAST: {
        gate: { locX: -83150, locY: 244579, locZ: -3730 },
        approach: { locX: -82750, locY: 244579, locZ: -3730 }
    },
    SOUTH: {
        gate: { locX: -84318, locY: 245800, locZ: -3730 },
        approach: { locX: -84318, locY: 246200, locZ: -3730 }
    }
};

const TownPathfinder = {
    isInsideTown(loc) {
        return loc.locX >= -85400 && loc.locX <= -83150 &&
               loc.locY >= 243227 && loc.locY <= 245800;
    },

    getGateByPosition(loc) {
        const dx = loc.locX - (-84318);
        const dy = loc.locY - 244579;
        const angle = Math.atan2(dy, dx);

        if (angle >= -3 * Math.PI / 4 && angle < -Math.PI / 4) {
            return GATES.NORTH;
        }
        if (angle >= Math.PI / 4 && angle < 3 * Math.PI / 4) {
            return GATES.SOUTH;
        }
        if (angle >= -Math.PI / 4 && angle < Math.PI / 4) {
            return GATES.EAST;
        }
        return GATES.WEST;
    },

    lineCircleIntersect(p1, p2, circle) {
        const dx = p2.locX - p1.locX;
        const dy = p2.locY - p1.locY;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return false;

        const t = ((circle.x - p1.locX) * dx + (circle.y - p1.locY) * dy) / lenSq;
        if (t < 0 || t > 1) {
            const dist1Sq = (p1.locX - circle.x) ** 2 + (p1.locY - circle.y) ** 2;
            const dist2Sq = (p2.locX - circle.x) ** 2 + (p2.locY - circle.y) ** 2;
            return dist1Sq < circle.r * circle.r || dist2Sq < circle.r * circle.r;
        }

        const cx = p1.locX + t * dx;
        const cy = p1.locY + t * dy;
        const distSq = (cx - circle.x) ** 2 + (cy - circle.y) ** 2;
        return distSq < circle.r * circle.r;
    },

    getObstacleAvoidedTarget(from, to) {
        const OBSTACLES = [
            { name: "Center Obelisk", x: -84318, y: 244579, r: 250 },
            { name: "North-West Building", x: -84800, y: 244000, r: 350 },
            { name: "North-East Temple", x: -83800, y: 243800, r: 400 },
            { name: "South-West Building", x: -84900, y: 245100, r: 350 },
            { name: "South-East Building", x: -83700, y: 245100, r: 350 }
        ];

        const intersects = OBSTACLES.some(obs => this.lineCircleIntersect(from, to, obs));
        if (intersects) {
            const center = { locX: -84318, locY: 244579, locZ: -3730 };
            const dxCenter = from.locX - center.locX;
            const dyCenter = from.locY - center.locY;
            const distToCenter = Math.sqrt(dxCenter * dxCenter + dyCenter * dyCenter);
            if (distToCenter > 300) {
                // Head to plaza center first to get clear line-of-sight
                return center;
            }
        }
        return to;
    },

    route(actor, from, to) {
        const fromInTown = this.isInsideTown(from);
        const toInTown = this.isInsideTown(to);

        let routedTo = to;

        // Case 1: Running from inside town to outside town (going to hunt)
        if (fromInTown && !toInTown) {
            const exitGate = this.getGateByPosition(to);
            const dx = from.locX - exitGate.gate.locX;
            const dy = from.locY - exitGate.gate.locY;
            if (Math.sqrt(dx*dx + dy*dy) < 400) {
                routedTo = to; // Already at the exit gate, run directly to target
            } else {
                routedTo = exitGate.gate; // Head to the exit gate first
            }
        }

        // Case 2: Running from outside town to inside town (returning to town)
        else if (!fromInTown && toInTown) {
            const exitGate = this.getGateByPosition(from);
            
            const dxApproach = from.locX - exitGate.approach.locX;
            const dyApproach = from.locY - exitGate.approach.locY;
            const distApproach = Math.sqrt(dxApproach * dxApproach + dyApproach * dyApproach);

            const dxGate = from.locX - exitGate.gate.locX;
            const dyGate = from.locY - exitGate.gate.locY;
            const distGate = Math.sqrt(dxGate * dxGate + dyGate * dyGate);

            if (distGate < 250) {
                routedTo = to; // Already at the gate, run directly inside
            } else if (distApproach < 250) {
                routedTo = exitGate.gate; // Lined up with approach, run to gate
            } else {
                routedTo = exitGate.approach; // Run to approach point first to align outside wall
            }
        }

        // Case 3: Both inside town (running from shop to plaza, etc.)
        else if (fromInTown && toInTown) {
            const dx = to.locX - from.locX;
            const dy = to.locY - from.locY;
            if (Math.sqrt(dx*dx + dy*dy) < 800) {
                routedTo = to; // Close enough, walk directly
            } else {
                // Otherwise, route via central plaza first to avoid clipping fences/corners
                const center = { locX: -84318, locY: 244579, locZ: -3730 };
                const dxCenter = from.locX - center.locX;
                const dyCenter = from.locY - center.locY;
                if (Math.sqrt(dxCenter*dxCenter + dyCenter*dyCenter) < 400) {
                    routedTo = to;
                } else {
                    routedTo = center;
                }
            }
        }

        // Apply obstacle avoidance inside town
        if (fromInTown) {
            return this.getObstacleAvoidedTarget(from, routedTo);
        }

        return routedTo;
    }
};

module.exports = TownPathfinder;
