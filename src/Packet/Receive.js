class ReceivePacket {
    constructor(buffer) {
        this.buffer = buffer;
        this.data   = new Array();
        this.offset = 1; // Skip the opcode id
    }

    // Standard data types

    read(size) {
        switch (size) {
            case 1: this.data.push(this.buffer.readUInt8   (this.offset)); break;
            case 2: this.data.push(this.buffer.readInt16LE (this.offset)); break;
            case 4: this.data.push(this.buffer.readInt32LE (this.offset)); break;
        }

        this.offset += size;
        return this;
    }

    readC() {
        return this.read(1);
    }

    readH() {
        return this.read(2);
    }

    readD() {
        return this.read(4);
    }

    // Special cases

    readB(size) {
        this.data.push(
            this.buffer.slice(this.offset, this.offset + size)
        );

        this.offset += size;
        return this;
    }

    readS() {
        let index = -1;
        for (let i = this.offset; i + 1 < this.buffer.length; i += 2) {
            if (this.buffer[i] === 0x00 && this.buffer[i + 1] === 0x00) {
                index = i;
                break;
            }
        }

        if (index >= 0) {
            this.data.push(utils.stripNull(
                this.buffer.toString('ucs2', this.offset, index)
            ));
            this.offset = index + 2;
        }
        return this;
    }
}

module.exports = ReceivePacket;
