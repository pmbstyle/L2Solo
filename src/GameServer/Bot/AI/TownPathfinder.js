const TownPathfinder = {
    isInsideTown(loc) {
        const dx = loc.locX - (-84318);
        const dy = loc.locY - 244579;
        return Math.sqrt(dx*dx + dy*dy) < 2200; // Talking Island Village radius
    },

    getClosestExit(targetLoc) {
        const exits = [
            { locX: -84081, locY: 243227, locZ: -3723 }, // North Exit (Newbie Guide)
            { locX: -85400, locY: 244579, locZ: -3730 }, // West Exit
            { locX: -83150, locY: 244579, locZ: -3730 }, // East Exit
            { locX: -84318, locY: 245800, locZ: -3730 }  // South Exit
        ];

        let closest = exits[0];
        let minDist = 9999999;

        exits.forEach((exit) => {
            const dx = targetLoc.locX - exit.locX;
            const dy = targetLoc.locY - exit.locY;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist < minDist) {
                minDist = dist;
                closest = exit;
            }
        });

        return closest;
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
            const exit = this.getClosestExit(to);
            const dx = from.locX - exit.locX;
            const dy = from.locY - exit.locY;
            if (Math.sqrt(dx*dx + dy*dy) < 400) {
                routedTo = to; // Already at the exit gate, run directly to target
            } else {
                routedTo = exit; // Head to the exit gate first
            }
        }

        // Case 2: Running from outside town to inside town (returning to town)
        else if (!fromInTown && toInTown) {
            const exit = this.getClosestExit(from);
            const dx = from.locX - exit.locX;
            const dy = from.locY - exit.locY;
            if (Math.sqrt(dx*dx + dy*dy) < 400) {
                routedTo = to; // Already at the exit gate, run directly to town destination
            } else {
                routedTo = exit; // Head to the exit gate first
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
