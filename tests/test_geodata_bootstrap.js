'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { ensureGeodata } = require('../scripts/geodata-bootstrap');

const rootDir = path.resolve(__dirname, '..');
const testRoot = path.join(rootDir, 'tmp', `test-geodata-bootstrap-${process.pid}-${Date.now()}`);

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const [name, value] of Object.entries(files)) {
        const filename = Buffer.from(name.replace(/\\/g, '/'));
        const contents = Buffer.from(value);
        const checksum = crc32(contents);
        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt32LE(checksum, 14);
        localHeader.writeUInt32LE(contents.length, 18);
        localHeader.writeUInt32LE(contents.length, 22);
        localHeader.writeUInt16LE(filename.length, 26);
        localParts.push(localHeader, filename, contents);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(20, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt32LE(checksum, 16);
        centralHeader.writeUInt32LE(contents.length, 20);
        centralHeader.writeUInt32LE(contents.length, 24);
        centralHeader.writeUInt16LE(filename.length, 28);
        centralHeader.writeUInt32LE(offset, 42);
        centralParts.push(centralHeader, filename);
        offset += localHeader.length + filename.length + contents.length;
    }

    const centralDirectory = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...localParts, centralDirectory, end]);
}

async function writeFixtureDirectory(directory) {
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(directory, 'test_01.l2j'), 'alpha');
    await fs.promises.writeFile(path.join(directory, 'test_02.l2j'), 'bravo!');
}

async function main() {
    const archive = createStoredZip({
        'test_01.l2j': 'alpha',
        'test_02.l2j': 'bravo!',
        'geo_index.txt': 'fixture\n'
    });
    const sha256 = crypto.createHash('sha256').update(archive).digest('hex');
    const requiredFiles = { 'test_01.l2j': 5, 'test_02.l2j': 6 };
    let requests = 0;
    const server = http.createServer((request, response) => {
        requests += 1;
        response.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': archive.length
        });
        response.end(archive);
    });

    await fs.promises.mkdir(testRoot, { recursive: true });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/geodata.zip`;
    const options = {
        url,
        sha256,
        minimumFileCount: 2,
        requiredFiles,
        logger: () => {}
    };

    try {
        const existingTarget = path.join(testRoot, 'existing', 'Geodata');
        await writeFixtureDirectory(existingTarget);
        const existing = await ensureGeodata({
            ...options,
            targetDirectory: existingTarget,
            tempDirectory: path.join(testRoot, 'existing-temp')
        });
        assert.strictEqual(existing.downloaded, false);
        assert.strictEqual(requests, 0, 'valid existing geodata must not use the network');

        const downloadTarget = path.join(testRoot, 'download', 'Geodata');
        const downloaded = await ensureGeodata({
            ...options,
            targetDirectory: downloadTarget,
            tempDirectory: path.join(testRoot, 'download-temp')
        });
        assert.strictEqual(downloaded.downloaded, true);
        assert.strictEqual(requests, 1);
        assert.strictEqual(await fs.promises.readFile(path.join(downloadTarget, 'test_01.l2j'), 'utf8'), 'alpha');
        const marker = JSON.parse(await fs.promises.readFile(path.join(downloadTarget, '.l2solo-geodata.json'), 'utf8'));
        assert.strictEqual(marker.sha256, sha256);
        assert.strictEqual(marker.fileCount, 2);

        const badTarget = path.join(testRoot, 'bad-checksum', 'Geodata');
        await assert.rejects(() => ensureGeodata({
            ...options,
            sha256: '0'.repeat(64),
            targetDirectory: badTarget,
            tempDirectory: path.join(testRoot, 'bad-temp')
        }), /checksum mismatch/);
        assert.strictEqual(fs.existsSync(badTarget), false, 'failed install must not create the target directory');
        assert.deepStrictEqual(await fs.promises.readdir(path.join(testRoot, 'bad-temp')), []);

        console.log('Geodata bootstrap checks passed');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fs.promises.rm(testRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
