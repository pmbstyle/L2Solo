// Town polygons and walk nodes are distilled from public L2J/L2jOrion town
// zone, mapregion, and bot random-walk data. Keep this file small and explicit:
// it is a routing hint layer, not a replacement for geodata.
const TOWNS = [
    {
        name: "Talking Island",
        center: { locX: -84108, locY: 244604, locZ: -3729 },
        polygon: [
            [-83739, 245733], [-84049, 246087], [-84289, 246258], [-84556, 246243],
            [-84984, 245820], [-85336, 245426], [-85684, 245099], [-85969, 244770],
            [-86400, 244292], [-86664, 243997], [-86940, 243631], [-87517, 243034],
            [-87650, 242799], [-87613, 242572], [-87348, 242246], [-86956, 241942],
            [-86656, 241684], [-86343, 241365], [-85829, 240966], [-85544, 240765],
            [-85193, 240440], [-84865, 240185], [-84594, 239866], [-84284, 239666],
            [-84002, 239734], [-83822, 239922], [-83640, 240190], [-83295, 240492],
            [-82990, 240878], [-82635, 241208], [-82234, 241698], [-82027, 241985],
            [-81684, 242328], [-81421, 242741], [-81113, 243073], [-81011, 243228],
            [-81029, 243496], [-81340, 243797], [-81691, 244028], [-82292, 244585],
            [-82787, 244999], [-83726, 245721]
        ],
        nodes: [
            { locX: -84108, locY: 244604, locZ: -3729 },
            { locX: -83990, locY: 243336, locZ: -3700 },
            { locX: -84512, locY: 242679, locZ: -3700 },
            { locX: -84623, locY: 243193, locZ: -3700 },
            { locX: -83761, locY: 243620, locZ: -3700 },
            { locX: -84903, locY: 243489, locZ: -3700 }
        ]
    },
    {
        name: "Gludin",
        center: { locX: -80752, locY: 149776, locZ: -3044 },
        polygon: [
            [-84867, 149371], [-82581, 149364], [-82499, 149139], [-81593, 149177],
            [-81551, 149410], [-79270, 149392], [-79275, 150365], [-79055, 150368],
            [-78820, 150429], [-78644, 150595], [-78558, 150837], [-78567, 152410],
            [-78796, 152420], [-78803, 154319], [-77131, 155437], [-78190, 156459],
            [-79978, 156104], [-84876, 156106]
        ],
        nodes: [
            { locX: -80752, locY: 149776, locZ: -3044 },
            { locX: -83520, locY: 150560, locZ: -3000 },
            { locX: -82464, locY: 150848, locZ: -3000 },
            { locX: -81787, locY: 150780, locZ: -3000 },
            { locX: -82035, locY: 152647, locZ: -3000 },
            { locX: -80053, locY: 154348, locZ: -3000 }
        ]
    },
    {
        name: "Gludio",
        center: { locX: -12736, locY: 122816, locZ: -3114 },
        polygon: [
            [-14960, 121148], [-14875, 121120], [-14717, 121106], [-14394, 121109],
            [-14242, 121104], [-12659, 121098], [-12025, 121767], [-12024, 123944],
            [-12277, 124668], [-12648, 125573], [-12879, 126199], [-13855, 126470],
            [-14484, 126463], [-15236, 126178], [-16126, 125356], [-16531, 124493],
            [-16537, 123850], [-16492, 123330], [-16194, 123160], [-16057, 123101],
            [-15327, 122741], [-14958, 121150]
        ],
        nodes: [
            { locX: -12736, locY: 122816, locZ: -3114 },
            { locX: -14288, locY: 122752, locZ: -3000 },
            { locX: -14592, locY: 123232, locZ: -3000 },
            { locX: -13904, locY: 123456, locZ: -3000 },
            { locX: -15314, locY: 124131, locZ: -3000 },
            { locX: -14279, locY: 124446, locZ: -3000 }
        ]
    },
    {
        name: "Dion",
        center: { locX: 15631, locY: 142885, locZ: -2704 },
        polygon: [
            [15264, 141764], [15434, 143574], [15760, 144707], [15846, 145302],
            [16134, 146850], [16715, 147153], [17844, 147640], [18139, 147138],
            [18541, 146758], [18782, 146598], [19069, 146521], [19430, 146485],
            [20363, 146421], [20722, 146319], [21415, 146319], [21402, 145011],
            [21381, 143675], [20696, 142841], [20380, 142492], [19060, 142463],
            [18821, 142512], [17885, 143046], [17447, 143348], [17019, 144028],
            [16780, 142908], [17344, 142847], [17327, 142650], [17483, 142634],
            [17396, 141776], [17238, 141792], [17218, 141574]
        ],
        nodes: [
            { locX: 15631, locY: 142885, locZ: -2704 },
            { locX: 18769, locY: 145629, locZ: -3108 },
            { locX: 18482, locY: 145795, locZ: -3088 },
            { locX: 17763, locY: 146746, locZ: -3114 },
            { locX: 17168, locY: 145258, locZ: -3048 },
            { locX: 17639, locY: 145415, locZ: -3068 },
            { locX: 19099, locY: 143987, locZ: -3071 }
        ]
    },
    {
        name: "Giran",
        center: { locX: 83396, locY: 147904, locZ: -3404 },
        polygon: [
            [77170, 147420], [79200, 147420], [79200, 144780], [80310, 144780],
            [80310, 143630], [83120, 143630], [83120, 143505], [83700, 143505],
            [83700, 141500], [84070, 141500], [84070, 143505], [85040, 143505],
            [85040, 145760], [86115, 145760], [86115, 146910], [88425, 146910],
            [88425, 147175], [90430, 147175], [90430, 147540], [88425, 147540],
            [88425, 150050], [86495, 150050], [86495, 150250], [85995, 150250],
            [85995, 152250], [86780, 152250], [86780, 153600], [84850, 153600],
            [84850, 152250], [85625, 152250], [85265, 150250], [85085, 150250],
            [85085, 149875], [83680, 149875], [83680, 149920], [83500, 149920],
            [83500, 151270], [82705, 151270], [82705, 152820], [79195, 152820],
            [79195, 149805], [77170, 149805]
        ],
        nodes: [
            { locX: 83396, locY: 147904, locZ: -3404 },
            { locX: 82248, locY: 148600, locZ: -3464 },
            { locX: 82072, locY: 147560, locZ: -3464 },
            { locX: 82792, locY: 147832, locZ: -3464 },
            { locX: 83320, locY: 147976, locZ: -3400 },
            { locX: 84584, locY: 148536, locZ: -3400 },
            { locX: 83384, locY: 149256, locZ: -3400 },
            { locX: 87016, locY: 148632, locZ: -3400 },
            { locX: 85816, locY: 148872, locZ: -3400 },
            { locX: 85832, locY: 153208, locZ: -3496 },
            { locX: 81384, locY: 150040, locZ: -3528 },
            { locX: 79656, locY: 150728, locZ: -3512 },
            { locX: 79272, locY: 149544, locZ: -3528 },
            { locX: 80744, locY: 146424, locZ: -3528 }
        ]
    },
    {
        name: "Oren",
        center: { locX: 82960, locY: 53177, locZ: -1497 },
        polygon: [
            [84014, 52245], [84138, 54683], [84143, 55029], [84001, 57029],
            [81773, 57023], [81795, 56237], [81239, 56236], [81282, 56892],
            [81187, 56904], [81105, 57179], [79195, 57167], [78986, 57076],
            [78844, 55218], [78843, 54882], [79148, 54560], [79660, 54556],
            [79662, 53994], [79002, 53990], [78963, 53359], [78959, 53070],
            [79027, 52125], [79628, 52070], [80547, 52068], [80835, 52116],
            [80733, 53068], [81306, 53070], [81369, 52310], [82605, 52244],
            [84010, 52250]
        ],
        nodes: [
            { locX: 82960, locY: 53177, locZ: -1497 },
            { locX: 80304, locY: 56241, locZ: -1500 },
            { locX: 80594, locY: 55837, locZ: -1500 },
            { locX: 79933, locY: 55752, locZ: -1500 },
            { locX: 80334, locY: 54400, locZ: -1500 },
            { locX: 82445, locY: 56012, locZ: -1480 },
            { locX: 82880, locY: 55390, locZ: -1480 },
            { locX: 82638, locY: 53885, locZ: -1440 },
            { locX: 80054, locY: 53209, locZ: -1500 }
        ]
    }
];

function distance(a, b) {
    const dx = a.locX - b.locX;
    const dy = a.locY - b.locY;
    return Math.sqrt((dx * dx) + (dy * dy));
}

function cloneLoc(loc) {
    return { locX: loc.locX, locY: loc.locY, locZ: loc.locZ };
}

function sameLoc(a, b) {
    return !!a && !!b && a.locX === b.locX && a.locY === b.locY && a.locZ === b.locZ;
}

function locLabel(loc) {
    if (!loc) return 'none';
    return `${loc.locX},${loc.locY},${loc.locZ}`;
}

function pointInPolygon(loc, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i][0];
        const yi = polygon[i][1];
        const xj = polygon[j][0];
        const yj = polygon[j][1];
        const intersects = ((yi > loc.locY) !== (yj > loc.locY)) &&
            (loc.locX < ((xj - xi) * (loc.locY - yi)) / ((yj - yi) || 1) + xi);
        if (intersects) {
            inside = !inside;
        }
    }
    return inside;
}

function closestTownByCenter(loc) {
    let best = null;
    let bestDistance = Infinity;
    for (const town of TOWNS) {
        const dist = distance(loc, town.center);
        if (dist < bestDistance) {
            best = town;
            bestDistance = dist;
        }
    }
    return bestDistance <= 1500 ? best : null;
}

function findTown(loc) {
    return TOWNS.find((town) => pointInPolygon(loc, town.polygon)) || closestTownByCenter(loc);
}

function nearestNode(town, loc) {
    let best = town.center;
    let bestDistance = Infinity;
    for (const node of town.nodes) {
        const dist = distance(node, loc);
        if (dist < bestDistance) {
            best = node;
            bestDistance = dist;
        }
    }
    return best;
}

function boundaryNodeToward(town, loc) {
    const dx = loc.locX - town.center.locX;
    const dy = loc.locY - town.center.locY;
    const len = Math.sqrt((dx * dx) + (dy * dy)) || 1;
    const nx = dx / len;
    const ny = dy / len;

    let best = town.center;
    let bestProjection = -Infinity;
    for (const point of town.polygon) {
        const projection = ((point[0] - town.center.locX) * nx) + ((point[1] - town.center.locY) * ny);
        if (projection > bestProjection) {
            bestProjection = projection;
            best = { locX: point[0], locY: point[1], locZ: town.center.locZ };
        }
    }
    return best;
}

function chooseNextTownStep(town, from, finalTarget) {
    let bestNode = null;
    let bestScore = Infinity;
    const currentTargetDistance = distance(from, finalTarget);

    if (currentTargetDistance <= 1500) {
        return finalTarget;
    }

    for (const node of town.nodes) {
        const fromDistance = distance(from, node);
        const targetDistance = distance(finalTarget, node);
        if (fromDistance <= 350 || targetDistance <= 350) {
            continue;
        }

        if (targetDistance >= currentTargetDistance - 100) {
            continue;
        }

        const score = fromDistance + targetDistance;
        if (score < bestScore) {
            bestNode = node;
            bestScore = score;
        }
    }

    if (bestNode) {
        return bestNode;
    }

    if (
        distance(from, town.center) > 700 &&
        distance(finalTarget, town.center) > 700 &&
        distance(town.center, finalTarget) < currentTargetDistance - 100
    ) {
        return town.center;
    }

    return finalTarget;
}

function createDiagnostics(from, to, routedTo, fromTown, toTown, routePlan, reason) {
    return {
        from: cloneLoc(from),
        to: cloneLoc(to),
        routedTo: cloneLoc(routedTo),
        fromTown: fromTown ? fromTown.name : null,
        toTown: toTown ? toTown.name : null,
        changedTarget: !sameLoc(routedTo, to),
        plan: routePlan ? {
            townName: routePlan.townName,
            finalTarget: cloneLoc(routePlan.finalTarget),
            waypoint: cloneLoc(routePlan.waypoint),
            createdAt: routePlan.createdAt,
            updatedAt: routePlan.updatedAt,
            reason: routePlan.reason
        } : null,
        reason
    };
}

function clearSessionRoute(session) {
    if (session) {
        session.townRoutePlan = null;
    }
}

const TownPathfinder = {
    towns: TOWNS,

    isInsideTown(loc) {
        return !!findTown(loc);
    },

    getTown(loc) {
        return findTown(loc);
    },

    routeWithSession(session, actor, from, to) {
        const now = Date.now();
        const existing = session ? session.townRoutePlan : null;
        if (existing) {
            const targetShift = distance(existing.finalTarget, to);
            const waypointDistance = distance(from, existing.waypoint);
            const expired = now - existing.createdAt > 30000;

            if (!expired && targetShift <= 900 && waypointDistance > 250) {
                existing.updatedAt = now;
                const fromTown = findTown(from);
                const toTown = findTown(to);
                return {
                    to: cloneLoc(existing.waypoint),
                    diagnostics: createDiagnostics(from, to, existing.waypoint, fromTown, toTown, existing, 'sticky_waypoint')
                };
            }

            clearSessionRoute(session);
        }

        const fromTown = findTown(from);
        const toTown = findTown(to);
        const routedTo = this.route(actor, from, to);
        const usesTownRoute = !sameLoc(routedTo, to);
        let routePlan = null;

        if (session && usesTownRoute) {
            routePlan = {
                townName: (fromTown || toTown)?.name || null,
                finalTarget: cloneLoc(to),
                waypoint: cloneLoc(routedTo),
                createdAt: now,
                updatedAt: now,
                reason: 'new_waypoint'
            };
            session.townRoutePlan = routePlan;
        }

        return {
            to: routedTo,
            diagnostics: createDiagnostics(from, to, routedTo, fromTown, toTown, routePlan, usesTownRoute ? 'new_waypoint' : 'direct')
        };
    },

    describeDiagnostics(diagnostics) {
        if (!diagnostics) return 'no path diagnostics';
        const route = `${locLabel(diagnostics.from)} -> ${locLabel(diagnostics.to)}`;
        const town = `${diagnostics.fromTown || 'field'} -> ${diagnostics.toTown || 'field'}`;
        const routed = diagnostics.changedTarget ? ` via ${locLabel(diagnostics.routedTo)}` : '';
        const plan = diagnostics.plan ? ` plan=${diagnostics.plan.townName || 'town'}/${diagnostics.reason}` : ` reason=${diagnostics.reason}`;
        return `${town}: ${route}${routed}${plan}`;
    },

    route(actor, from, to) {
        const fromTown = findTown(from);
        const toTown = findTown(to);

        if (!fromTown && !toTown) {
            return to;
        }

        if (fromTown && toTown && fromTown.name === toTown.name) {
            if (distance(from, to) <= 700) {
                return to;
            }
            return chooseNextTownStep(fromTown, from, to);
        }

        if (fromTown && !toTown) {
            const exit = boundaryNodeToward(fromTown, to);
            const staging = nearestNode(fromTown, exit);
            if (distance(from, exit) <= 350) {
                return to;
            }
            if (distance(from, staging) > 350 && distance(exit, staging) > 350) {
                return staging;
            }
            if (distance(from, exit) > 350) {
                return exit;
            }
            return to;
        }

        if (!fromTown && toTown) {
            const entry = boundaryNodeToward(toTown, from);
            if (distance(from, entry) > 350) {
                return entry;
            }
            return chooseNextTownStep(toTown, from, to);
        }

        return to;
    }
};

module.exports = TownPathfinder;
