// Decoding the graph endpoint's compressed form. The platform proxy does not gzip responses, so the backend can
// return { encoding: 'gzip-base64', data: base64(gzip(graph JSON)) } when asked with ?encoding=gzip64.
// Framework-free: no @angular imports (unit-tested under Node, which has DecompressionStream).

import type { NetworkGraph } from './api-types';

export const GZIP_BASE64 = 'gzip-base64';

/** The query the UI sends: raw only for the kinds the path engine reads, and the compressed body. */
export const GRAPH_QUERY = 'raw=routing&encoding=gzip64';

export interface EncodedBody {
  encoding: string;
  data: string;
}

export function isEncodedBody(body: unknown): body is EncodedBody {
  const b = body as EncodedBody | null;
  return !!b && typeof b === 'object' && typeof b.encoding === 'string' && typeof b.data === 'string';
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function gunzipText(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/**
 * The graph from a graph-endpoint body. A body without an `encoding` field is the plain graph (an older backend
 * that ignores the query). Rejects when an encoded body cannot be decoded — the caller then re-requests plain JSON.
 */
export async function decodeGraphBody(body: unknown): Promise<NetworkGraph> {
  if (!isEncodedBody(body)) return body as NetworkGraph;
  if (body.encoding !== GZIP_BASE64) throw new Error(`Unsupported graph encoding '${body.encoding}'.`);
  const graph = JSON.parse(await gunzipText(base64ToBytes(body.data))) as NetworkGraph;
  if (!graph || !Array.isArray(graph.nodes)) throw new Error('Decoded graph has no nodes.');
  return graph;
}
