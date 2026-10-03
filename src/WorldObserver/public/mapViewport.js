(function exposeMapViewport(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WorldObserverMapViewport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createMapViewport() {
    function metrics(viewport, rect) {
        const scale = Math.max(0.0001, Math.min(rect.width / viewport.width, rect.height / viewport.height));
        const gutterX = (rect.width - viewport.width * scale) / 2;
        const gutterY = (rect.height - viewport.height * scale) / 2;
        return {
            rect, scale,
            left: rect.left + gutterX,
            top: rect.top + gutterY,
            // SVG's centered "meet" transform also shows map content in the gutters.
            visible: {
                x: viewport.x - gutterX / scale,
                y: viewport.y - gutterY / scale,
                width: rect.width / scale,
                height: rect.height / scale
            }
        };
    }

    function frameRenderer(render, requestFrame) {
        let pending = false;
        return function schedule() {
            if (pending) return;
            pending = true;
            requestFrame(() => {
                pending = false;
                render();
            });
        };
    }

    return Object.freeze({ metrics, frameRenderer });
}));
