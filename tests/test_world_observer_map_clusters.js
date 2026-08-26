const assert = require('assert');

const MapClusters = require('../src/WorldObserver/public/mapClusters');

const points = [
    { id: 'a', point: { x: 5, y: 5 } },
    { id: 'b', point: { x: 55, y: 5 } },
    { id: 'c', point: { x: 105, y: 5 } }
];
const clusters = MapClusters.clusterProjected(points, { cellSize: 60 });
assert.strictEqual(clusters.length, 2, 'fixed cells must not transitively merge a chain of nearby actors');
assert.deepStrictEqual(clusters.map((cluster) => cluster.members.map((item) => item.id).sort()).sort(), [['a', 'b'], ['c']]);
assert.deepStrictEqual(clusters.find((cluster) => cluster.size === 2).point, { x: 30, y: 5 });

const visible = MapClusters.clusterProjected([
    { id: 'inside', point: { x: 20, y: 20 } },
    { id: 'margin', point: { x: 108, y: 20 } },
    { id: 'outside', point: { x: 130, y: 20 } }
], {
    cellSize: 20,
    viewport: { x: 0, y: 0, width: 100, height: 100 },
    margin: 10
});
assert.deepStrictEqual(visible.flatMap((cluster) => cluster.members.map((item) => item.id)).sort(), ['inside', 'margin']);

console.log('World observer map cluster checks passed');
