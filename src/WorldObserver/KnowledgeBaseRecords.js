'use strict';

// Owns reading a generated knowledge-base array file (data/KnowledgeBase/{items,mobs,spawns}.json) one record at a
// time, so the main thread keeps byte ranges instead of the parsed records. The ranges come from one scan at load
// over the generator's layout (`jsonText` in scripts/generate-knowledge-base.js, JSON.stringify(_, null, 2)): the
// file is "[\n  " + record + ",\n  " + record ... + "\n]\n", and a record's closing brace is the first "\n  }" after
// its opening one, because deeper lines are indented further and a JSON string holds no raw newline. Every record is
// parsed once at load (the caller keeps what its readers need), and read again on demand with a positioned read on
// a descriptor held open for the process: the generator replaces a file by rename, so a running server keeps
// reading the bytes it scanned. Caller: KnowledgeBaseService (main thread).
const fs = require('fs');

const FIRST = Buffer.from('[\n  ');
const BETWEEN = Buffer.from(',\n  ');
const CLOSE = Buffer.from('\n  }');
const LAST = Buffer.from('\n]\n');
const EMPTY = Buffer.from('[]\n');
const OPEN_BRACE = 0x7b;

function readBytes(fd, start, length) {
    const bytes = Buffer.allocUnsafe(length);
    for (let done = 0; done < length;) {
        const read = fs.readSync(fd, bytes, done, length - done, start + done);
        if (!read) throw new Error(`Knowledge base file ended at byte ${start + done} of a ${length}-byte read`);
        done += read;
    }
    return bytes;
}

// The byte range of every record of a file's bytes, visiting each parsed record once, in file order. Kept apart
// from the reader so its closures do not hold the whole file.
function scanRecords(bytes, filePath, visit) {
    const at = (pattern, position) => position + pattern.length <= bytes.length
        && bytes.compare(pattern, 0, pattern.length, position, position + pattern.length) === 0;
    const layoutError = (position) => new Error(`${filePath} is not in the generator's layout at byte ${position}; `
        + 'run npm run generate:knowledge-base');
    const starts = [], ends = [];
    if (bytes.equals(EMPTY)) return { starts, ends };
    if (!at(FIRST, 0)) throw layoutError(0);
    for (let start = FIRST.length; ;) {
        if (bytes[start] !== OPEN_BRACE) throw layoutError(start);
        const close = bytes.indexOf(CLOSE, start);
        if (close < 0) throw layoutError(start);
        const end = close + CLOSE.length;
        const record = JSON.parse(bytes.toString('utf8', start, end));
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw layoutError(start);
        visit(record, starts.length);
        starts.push(start);
        ends.push(end);
        if (at(BETWEEN, end)) start = end + BETWEEN.length;
        else if (end + LAST.length === bytes.length && at(LAST, end)) return { starts, ends };
        else throw layoutError(end);
    }
}

// visit(record, index) sees each parsed record once, in file order. Returns the on-demand reader; a failed scan
// closes the descriptor.
function openRecordFile(filePath, visit) {
    const fd = fs.openSync(filePath, 'r');
    let size, starts, ends;
    try {
        size = fs.fstatSync(fd).size;
        ({ starts, ends } = scanRecords(readBytes(fd, 0, size), filePath, visit));
    } catch (error) {
        fs.closeSync(fd);
        throw error;
    }
    // Byte ranges per record index; the files are tens of MB, far below 2^32.
    const startOf = Uint32Array.from(starts), endOf = Uint32Array.from(ends);

    function read(index) {
        const start = startOf[index];
        return JSON.parse(readBytes(fd, start, endOf[index] - start).toString('utf8'));
    }
    // Records first..last (inclusive, adjacent in the file) in one read: the bytes between them are ",\n  ".
    function readRun(first, last) {
        const start = startOf[first];
        return JSON.parse(`[${readBytes(fd, start, endOf[last] - start).toString('utf8')}]`);
    }
    // indexes: record indexes, in the caller's order; adjacent ascending ones share one read.
    function readMany(indexes) {
        const records = [];
        for (let first = 0; first < indexes.length;) {
            let last = first;
            while (last + 1 < indexes.length && indexes[last + 1] === indexes[last] + 1) last++;
            records.push(...(first === last ? [read(indexes[first])] : readRun(indexes[first], indexes[last])));
            first = last + 1;
        }
        return records;
    }
    // The whole array, parsed fresh (no runtime reader; the exported catalogue's potentialSpawnData).
    const readAll = () => JSON.parse(readBytes(fd, 0, size).toString('utf8'));

    // Only for a load that fails after this file opened; a loaded file stays open for the process.
    const close = () => fs.closeSync(fd);

    return Object.freeze({ count: startOf.length, read, readMany, readAll, close });
}

module.exports = { openRecordFile };
