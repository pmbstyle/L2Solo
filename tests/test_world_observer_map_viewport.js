const assert = require('assert');
const MapViewport = require('../src/WorldObserver/public/mapViewport');
const MapClusters = require('../src/WorldObserver/public/mapClusters');

const viewport = { x: 1000, y: 2000, width: 4000, height: 4000 };
const wide = MapViewport.metrics(viewport, { left: 200, top: 100, width: 1200, height: 400 });
assert.deepStrictEqual(wide.visible, { x: -3000, y: 2000, width: 12000, height: 4000 });
const gutterPoints = [
    { id: 'left', point: { x: -1000, y: 3000 } },
    { id: 'center', point: { x: 3000, y: 3000 } },
    { id: 'right', point: { x: 7000, y: 3000 } },
    { id: 'outside', point: { x: 11000, y: 3000 } }
];
assert.deepStrictEqual(MapClusters.clusterProjected(gutterPoints, {
    cellSize: 580, viewport: wide.visible, margin: 720
}).flatMap(group => group.members.map(item => item.id)).sort(), ['center', 'left', 'right'],
'markers visible in the SVG side gutters must not disappear at the internal viewBox edges');

const tall = MapViewport.metrics(viewport, { left: 200, top: 100, width: 400, height: 1200 });
assert.deepStrictEqual(tall.visible, { x: 1000, y: -2000, width: 4000, height: 12000 });
const matched = MapViewport.metrics(viewport, { left: 200, top: 100, width: 800, height: 800 });
assert.deepStrictEqual(matched.visible, viewport);
for (const metrics of [wide, tall, matched]) {
    assert.strictEqual((metrics.rect.left - metrics.left) / metrics.scale + viewport.x, metrics.visible.x);
    assert.strictEqual((metrics.rect.top - metrics.top) / metrics.scale + viewport.y, metrics.visible.y);
    assert.strictEqual(metrics.visible.width * metrics.scale, metrics.rect.width);
    assert.strictEqual(metrics.visible.height * metrics.scale, metrics.rect.height);
}

// A burst of pointer/wheel events must paint the final position once, then
// remain responsive to the next frame instead of losing later interactions.
const frames = [], painted = [];
let position = 0;
const schedule = MapViewport.frameRenderer(() => painted.push(position), callback => frames.push(callback));
for (let next = 1; next <= 50; next++) { position = next; schedule(); }
assert.strictEqual(frames.length, 1);
frames.shift()();
assert.deepStrictEqual(painted, [50]);
position = 75;
schedule();
frames.shift()();
assert.deepStrictEqual(painted, [50, 75]);

console.log('Observer map: wide/tall visible bounds and coalesced interaction frames passed');
