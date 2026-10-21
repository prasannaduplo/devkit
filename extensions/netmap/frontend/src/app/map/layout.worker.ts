/// <reference lib="webworker" />
import ELK from 'elkjs/lib/elk.bundled.js';

// Runs ELK off the main thread. Messages: { id, graph } in → { id, graph } or { id, error } out.
const elk = new ELK();

addEventListener('message', async ({ data }: MessageEvent<{ id: number; graph: unknown }>) => {
  try {
    const graph = await elk.layout(data.graph as any);
    postMessage({ id: data.id, graph });
  } catch (err) {
    postMessage({ id: data.id, error: String(err) });
  }
});
