/**
 * Sooloos DistributedBroker binary deserializer.
 *
 * Parses serialized .NET objects from Roon's binary protocol.
 * The serialization format uses:
 *   - BE varints for string lengths and object sizes
 *   - Numbered fields (1-byte field tag followed by typed value)
 *   - 0x00 as end-of-object marker
 *   - Type references before each object in a DataList
 *
 * Key types:
 *   - LocalizedDescriptionContainer: { blobs: LocalizedDescriptionText[], images: Map }
 *   - LocalizedDescriptionText: { source, language, text, author, sourceUrl }
 */

'use strict';

const { decodeVarintBE, decodeVarintLE } = require('./sooloos-varint.cjs');

/**
 * Read a BE-varint-prefixed string from buffer.
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ value: string, bytesRead: number } | null}
 */
function readString(buf, offset) {
    const len = decodeVarintBE(buf, offset);
    if (!len) return null;
    const start = offset + len.bytesRead;
    if (start + len.value > buf.length) return null;
    return {
        value: buf.toString('utf-8', start, start + len.value),
        bytesRead: len.bytesRead + len.value,
    };
}

/**
 * Parse a LocalizedDescriptionText object from buffer.
 * Fields: 01=Source, 02=Language, 03=Text, 04=Author, 05=SourceUrl
 *
 * @param {Buffer} buf
 * @param {number} offset - start of object data (after type ref + size varint)
 * @param {number} size - total object size (from header varint, includes 0x00 terminator)
 * @returns {{ source: string, language: string, text: string, author: string|null, sourceUrl: string|null, bytesRead: number }}
 */
function parseLocalizedDescriptionText(buf, offset, size) {
    const end = offset + size;
    const result = { source: null, language: null, text: null, author: null, sourceUrl: null };
    let pos = offset;

    while (pos < end) {
        const fieldTag = buf[pos];
        if (fieldTag === 0x00) {
            pos++;
            break; // end-of-object
        }
        pos++;

        const str = readString(buf, pos);
        if (!str) break;
        pos += str.bytesRead;

        switch (fieldTag) {
            case 0x01: result.source = str.value; break;
            case 0x02: result.language = str.value; break;
            case 0x03: result.text = str.value; break;
            case 0x04: result.author = str.value; break;
            case 0x05: result.sourceUrl = str.value; break;
        }
    }

    return { ...result, bytesRead: pos - offset };
}

/**
 * Find the start of the serialized data section within a response buffer.
 *
 * The response may contain a type schema section (starting with 0x07)
 * before the actual data. This function skips past the schema by
 * searching for the end-of-schema marker.
 *
 * @param {Buffer} buf
 * @returns {number} offset where data section begins
 */
function findDataStart(buf) {
    // Look for the end of the type schema section.
    // The schema defines types like "LocalizedDescriptionContainer" and ends
    // with the DataList type name followed by 0x00.
    const marker = Buffer.from('DataList<Sooloos.Broker.Api.LocalizedDescriptionText>');
    const idx = buf.indexOf(marker);
    if (idx >= 0) {
        let pos = idx + marker.length;
        // Skip any trailing schema bytes until 0x00
        while (pos < buf.length && buf[pos] !== 0x00) pos++;
        if (pos < buf.length) return pos + 1; // skip the 0x00
    }
    // No schema found — data starts at beginning
    return 0;
}

/**
 * Parse a LocalizedDescriptionContainer from a biography response buffer.
 *
 * This is the main entry point for parsing biography/review responses
 * from GetLocalizedEntityText RPC calls.
 *
 * @param {Buffer} buf - raw response data (may include type schema prefix)
 * @returns {{ blobs: Array<{source: string, language: string, text: string, author: string|null, sourceUrl: string|null}>, selectedBlob: number|null }}
 */
function parseLocalizedDescriptionContainer(buf) {
    let pos = findDataStart(buf);
    const result = { blobs: [], selectedBlob: null };

    // Response data envelope: skip header varints until we reach the DataList
    // Structure observed: <envelope_varints...> <item_count> <items...>
    //
    // The envelope contains reference IDs and type markers. We need to
    // find the item count for the Blobs DataList.
    //
    // Strategy: scan forward through BE varints until we find a small value
    // (the item count, typically 1-5) followed by the blob item pattern:
    //   <item_marker(01)> <type_ref(55)> <size_varint>

    // Skip envelope varints
    const envelopeStart = pos;
    while (pos < buf.length - 3) {
        // Check if this looks like the start of a DataList:
        // <count> 01 55 <size_varint>
        const v = decodeVarintBE(buf, pos);
        if (!v) break;

        // Check if next bytes match item pattern: 01 55
        const afterVarint = pos + v.bytesRead;
        if (v.value >= 1 && v.value <= 10 &&
            afterVarint + 1 < buf.length &&
            buf[afterVarint] === 0x01 &&
            buf[afterVarint + 1] === 0x55) {
            // Found the DataList! v.value = item count
            const itemCount = v.value;
            pos = afterVarint;

            for (let i = 0; i < itemCount; i++) {
                // Each item: 01 <type_ref> <size_varint> <fields...> 00
                if (pos >= buf.length || buf[pos] !== 0x01) break;
                pos++; // skip 01 marker

                const typeRef = decodeVarintBE(buf, pos);
                if (!typeRef) break;
                pos += typeRef.bytesRead;

                const size = decodeVarintBE(buf, pos);
                if (!size) break;
                pos += size.bytesRead;

                const blob = parseLocalizedDescriptionText(buf, pos, size.value);
                result.blobs.push({
                    source: blob.source,
                    language: blob.language,
                    text: blob.text,
                    author: blob.author,
                    sourceUrl: blob.sourceUrl,
                });
                pos += blob.bytesRead;
            }
            break;
        }

        pos += v.bytesRead;
    }

    return result;
}

module.exports = {
    readString,
    parseLocalizedDescriptionText,
    parseLocalizedDescriptionContainer,
    findDataStart,
};
