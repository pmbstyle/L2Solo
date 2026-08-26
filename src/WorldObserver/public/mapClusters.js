(function exposeMapClusters(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WorldObserverMapClusters = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createMapClusters() {
    function finite(value) {
        return Number.isFinite(Number(value));
    }

    function insideViewport(point, viewport, margin) {
        if (!viewport) return true;
        return point.x >= viewport.x - margin
            && point.x <= viewport.x + viewport.width + margin
            && point.y >= viewport.y - margin
            && point.y <= viewport.y + viewport.height + margin;
    }

    function clusterProjected(items, options = {}) {
        const cellSize = Math.max(1, Number(options.cellSize || 1));
        const viewport = options.viewport || null;
        const margin = Math.max(0, Number(options.margin || 0));
        const cells = new Map();

        (items || []).forEach((item) => {
            const point = item?.point;
            if (!finite(point?.x) || !finite(point?.y)) return;
            if (!insideViewport(point, viewport, margin)) return;

            const cellX = Math.floor(Number(point.x) / cellSize);
            const cellY = Math.floor(Number(point.y) / cellSize);
            const key = `${cellX}:${cellY}`;
            let cell = cells.get(key);
            if (!cell) {
                cell = { members: [], sumX: 0, sumY: 0 };
                cells.set(key, cell);
            }
            cell.members.push(item);
            cell.sumX += Number(point.x);
            cell.sumY += Number(point.y);
        });

        return [...cells.values()]
            .map((cell) => ({
                members: cell.members,
                point: {
                    x: cell.sumX / cell.members.length,
                    y: cell.sumY / cell.members.length
                },
                size: cell.members.length
            }))
            .sort((left, right) => left.size - right.size);
    }

    return Object.freeze({ clusterProjected });
}));
