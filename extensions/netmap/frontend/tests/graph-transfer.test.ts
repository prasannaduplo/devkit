import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { base64ToBytes, decodeGraphBody, GZIP_BASE64, isEncodedBody } from '../src/app/model/graph-transfer';
import { hubFixture } from './fixture';

const encode = (value: unknown) => ({ encoding: GZIP_BASE64, data: gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('base64') });

describe('graph transfer decoding', () => {
  it('decodes base64 to the original bytes', () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
    expect(Array.from(base64ToBytes(Buffer.from(bytes).toString('base64')))).toEqual(Array.from(bytes));
  });

  it('round-trips the fixture graph through gzip-base64', async () => {
    const graph = hubFixture().graph;
    const body = encode(graph);
    expect(isEncodedBody(body)).toBe(true);
    expect(await decodeGraphBody(body)).toEqual(graph);
  });

  it('keeps non-ASCII text intact', async () => {
    const graph = { schemaVersion: 1, nodes: [{ id: 'n', name: 'Zürich – egress ✓' }], edges: [], findings: [] };
    expect(await decodeGraphBody(encode(graph))).toEqual(graph);
  });

  it('treats a body without an encoding field as the plain graph (older backend)', async () => {
    const graph = hubFixture().graph;
    expect(isEncodedBody(graph)).toBe(false);
    expect(await decodeGraphBody(graph)).toBe(graph);
  });

  it('rejects an undecodable or unknown encoding so the caller can fall back', async () => {
    await expect(decodeGraphBody({ encoding: GZIP_BASE64, data: 'bm90IGd6aXA=' })).rejects.toBeTruthy();
    await expect(decodeGraphBody({ encoding: 'br', data: '' })).rejects.toThrow(/Unsupported/);
  });
});
