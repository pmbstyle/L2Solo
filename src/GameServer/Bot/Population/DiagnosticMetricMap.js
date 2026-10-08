'use strict';
// Optional retained dimensions are bounded even when a reason includes an owner
// or external error. The overflow bucket preserves aggregate counts.
const KEY_LIMIT = 64;
const KEY_BYTES = 96;
class DiagnosticMetricMap extends Map {
    key(value) {
        const key = String(value).slice(0, KEY_BYTES);
        return super.has(key) || this.size < KEY_LIMIT - 1 ? key : 'other';
    }
    get(value) { return super.get(this.key(value)); }
    has(value) { return super.has(this.key(value)); }
    set(value, item) { return super.set(this.key(value), item); }
}
module.exports = { DiagnosticMetricMap, KEY_LIMIT, KEY_BYTES };
