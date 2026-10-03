(function exposeAtlas(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WorldObserverMapAtlas = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createAtlas() {
    const hiddenRanges = [
        { minX: 16, maxX: 22, minY: 10, maxY: 12 },
        { minX: 16, maxX: 18, minY: 13, maxY: 13 },
        { minX: 26, maxX: 26, minY: 14, maxY: 14 },
        { minX: 26, maxX: 26, minY: 20, maxY: 21 },
        { minX: 25, maxX: 25, minY: 21, maxY: 21 },
        { minX: 19, maxX: 20, minY: 25, maxY: 25 }
    ];
    const metadata = {
        source: 'https://github.com/npetrovski/l2-world-map',
        rawBaseUrl: '/observer/map-tiles', extension: 'webp',
        blockSize: 32768, blockPx: 900,
        x: { min: 16, max: 26, mid: 20 }, y: { min: 11, max: 25, mid: 18 },
        missingTiles: ['17_14', '18_13', '26_13', '26_15', '26_16', '26_17', '26_18', '26_19'],
        hiddenRanges
    };
    function hidden(x, y) { return hiddenRanges.some((range) => x >= range.minX && x <= range.maxX && y >= range.minY && y <= range.maxY); }
    function project(loc) {
        return {
            x: (Number(loc.locX) / metadata.blockSize + metadata.x.mid - metadata.x.min) * metadata.blockPx,
            y: (Number(loc.locY) / metadata.blockSize + metadata.y.mid - metadata.y.min) * metadata.blockPx
        };
    }
    return Object.freeze({ metadata, hidden, project });
}));
