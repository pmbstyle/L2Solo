'use strict';

module.exports = function verifyGeodataWhenAvailable(engine, regions, label, verify) {
    const missing = regions.filter(([regionX, regionY]) => !engine.loadRegion(regionX, regionY));
    if (missing.length > 0) {
        console.log(`SKIP: ${label} raw geodata region(s) ${missing.map((region) => region.join('_')).join(', ')} are not available`);
        return false;
    }

    verify();
    return true;
};
