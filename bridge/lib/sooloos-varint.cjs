/**
 * Sooloos DistributedBroker varint encoding/decoding.
 *
 * The protocol uses TWO different varint encodings:
 *
 * 1. **LE varint** (Little-Endian, standard protobuf)
 *    - Used in: message framing (0x43 RPC calls, 0xc0 responses), schema type refs
 *    - First byte = least significant 7 bits
 *    - MSB = continuation bit (1 = more bytes follow)
 *
 * 2. **BE varint** (Big-Endian, .NET serialization layer)
 *    - Used in: string lengths, object sizes, field data within serialized objects
 *    - First byte = most significant 7 bits
 *    - MSB = continuation bit (1 = more bytes follow)
 *
 * Both use 7 data bits per byte with MSB as continuation flag,
 * but differ in significance order of the data bits.
 */

'use strict';

/**
 * Decode a Little-Endian varint (protobuf-style).
 * First byte = least significant bits.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ value: number, bytesRead: number } | null}
 */
function decodeVarintLE(buf, offset) {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 10; i++) {
        if (offset + i >= buf.length) return null;
        const b = buf[offset + i];
        result |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) === 0) {
            return { value: result, bytesRead: i + 1 };
        }
    }
    return null;
}

/**
 * Encode a value as Little-Endian varint (protobuf-style).
 *
 * @param {number} value
 * @returns {Buffer}
 */
function encodeVarintLE(value) {
    const bytes = [];
    do {
        let b = value & 0x7f;
        value >>>= 7;
        if (value > 0) b |= 0x80;
        bytes.push(b);
    } while (value > 0);
    return Buffer.from(bytes);
}

/**
 * Decode a Big-Endian varint (Sooloos serialization).
 * First byte = most significant bits.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ value: number, bytesRead: number } | null}
 */
function decodeVarintBE(buf, offset) {
    const dataBits = [];
    let bytesRead = 0;
    for (let i = 0; i < 10; i++) {
        if (offset + i >= buf.length) return null;
        const b = buf[offset + i];
        dataBits.push(b & 0x7f);
        bytesRead = i + 1;
        if ((b & 0x80) === 0) break;
    }
    // First byte has the most significant bits
    let result = 0;
    for (let i = 0; i < dataBits.length; i++) {
        result |= dataBits[dataBits.length - 1 - i] << (i * 7);
    }
    return { value: result, bytesRead };
}

/**
 * Encode a value as Big-Endian varint (Sooloos serialization).
 *
 * @param {number} value
 * @returns {Buffer}
 */
function encodeVarintBE(value) {
    if (value === 0) return Buffer.from([0]);
    const groups = [];
    while (value > 0) {
        groups.push(value & 0x7f);
        value >>>= 7;
    }
    // groups[0] = least significant, groups[N-1] = most significant
    // BE: first byte = most significant
    const bytes = [];
    for (let i = groups.length - 1; i >= 0; i--) {
        let b = groups[i];
        if (i > 0) b |= 0x80; // continuation for all except last
        bytes.push(b);
    }
    return Buffer.from(bytes);
}

module.exports = {
    decodeVarintLE,
    encodeVarintLE,
    decodeVarintBE,
    encodeVarintBE,
};
