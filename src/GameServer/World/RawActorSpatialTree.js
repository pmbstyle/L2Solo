'use strict';

// Spatial metadata references the existing cells; characters stay in their
// canonical cell Sets. AVL bounds let global nearest queries skip distant cells.
function height(node) { return node?.height || 0; }
function refresh(node) {
    node.height = 1 + Math.max(height(node.left), height(node.right));
    node.minX = Math.min(node.bounds.minX, node.left?.minX ?? Infinity, node.right?.minX ?? Infinity);
    node.minY = Math.min(node.bounds.minY, node.left?.minY ?? Infinity, node.right?.minY ?? Infinity);
    node.maxX = Math.max(node.bounds.maxX, node.left?.maxX ?? -Infinity, node.right?.maxX ?? -Infinity);
    node.maxY = Math.max(node.bounds.maxY, node.left?.maxY ?? -Infinity, node.right?.maxY ?? -Infinity);
    node.players = !!(node.cell.rawPlayers?.size || node.left?.players || node.right?.players);
    return node;
}
function rotate(node, side) {
    const other = side === 'left' ? 'right' : 'left';
    const next = node[other];
    node[other] = next[side]; next[side] = refresh(node);
    return refresh(next);
}
function balance(node) {
    refresh(node);
    const difference = height(node.left) - height(node.right);
    if (difference > 1) {
        if (height(node.left.left) < height(node.left.right)) node.left = rotate(node.left, 'left');
        return rotate(node, 'right');
    }
    if (difference < -1) {
        if (height(node.right.right) < height(node.right.left)) node.right = rotate(node.right, 'right');
        return rotate(node, 'left');
    }
    return node;
}
function compare(a, b) { return a.x - b.x || a.y - b.y; }
function change(node, cell, bounds) {
    if (!node) return bounds ? refresh({ cell, bounds, left: null, right: null }) : null;
    const order = compare(cell, node.cell);
    if (order < 0) node.left = change(node.left, cell, bounds);
    else if (order > 0) node.right = change(node.right, cell, bounds);
    else if (bounds) { node.cell = cell; node.bounds = bounds; }
    else {
        if (!node.left) return node.right;
        if (!node.right) return node.left;
        let successor = node.right;
        while (successor.left) successor = successor.left;
        node.cell = successor.cell; node.bounds = successor.bounds;
        node.right = change(node.right, successor.cell, null);
    }
    return balance(node);
}
function lowerDistance(point, node) {
    const dx = Math.max(node.minX - point.locX, 0, point.locX - node.maxX);
    const dy = Math.max(node.minY - point.locY, 0, point.locY - node.maxY);
    return dx * dx + dy * dy;
}
function push(heap, item) {
    let i = heap.length; heap.push(item);
    while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent].distance <= item.distance) break;
        heap[i] = heap[parent]; i = parent;
    }
    heap[i] = item;
}
function pop(heap) {
    const first = heap[0], last = heap.pop();
    if (!heap.length) return first;
    let i = 0;
    while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].distance < heap[child].distance) child++;
        if (heap[child].distance >= last.distance) break;
        heap[i] = heap[child]; i = child;
    }
    heap[i] = last; return first;
}

class RawActorSpatialTree {
    constructor() { this.root = null; }
    update(cell, bounds) { this.root = change(this.root, cell, bounds); }
    clear() { this.root = null; }
    nearest(point, players, visit, check) {
        const queue = [];
        let best = Infinity;
        const add = node => {
            if (!node || (players && !node.players)) return;
            const distance = lowerDistance(point, node);
            if (distance <= best) push(queue, { node, distance });
        };
        add(this.root);
        while (queue.length) {
            check?.();
            const { node, distance } = pop(queue);
            if (distance > best) break;
            best = visit(node.cell, best);
            add(node.left); add(node.right);
        }
    }
}
module.exports = RawActorSpatialTree;
