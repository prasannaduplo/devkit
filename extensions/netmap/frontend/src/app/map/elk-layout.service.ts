import { Injectable } from '@angular/core';
import { ElkLike, ElkNode, Scene, layoutView } from '../model/layout';
import { SeverityContext } from '../model/severity';
import { ViewModel } from '../model/zoom';

interface Pending { resolve: (g: ElkNode) => void; reject: (e: Error) => void; graph: ElkNode; timer: ReturnType<typeof setTimeout> }

/** Runs ELK in a web worker when the federated remote can start one; otherwise (or after any worker failure or a
 * 15 s silence) on the main thread. The caller shows a loading state either way. */
@Injectable({ providedIn: 'root' })
export class ElkLayoutService {
  private worker?: Worker;
  private workerFailed = false;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private main?: ElkLike;

  async layout(view: ViewModel, ctx: SeverityContext): Promise<Scene> {
    const worker = this.ensureWorker();
    const engine: ElkLike = worker ? { layout: g => this.viaWorker(worker, g) } : await this.mainThread();
    return layoutView(view, engine, ctx);
  }

  private ensureWorker(): Worker | undefined {
    if (this.workerFailed || typeof Worker === 'undefined') return undefined;
    if (this.worker) return this.worker;
    try {
      const w = new Worker(new URL('./layout.worker', import.meta.url), { type: 'module' });
      w.onmessage = ({ data }: MessageEvent<{ id: number; graph?: ElkNode; error?: string }>) => {
        const p = this.pending.get(data.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(data.id);
        if (data.error) p.reject(new Error(data.error));
        else p.resolve(data.graph!);
      };
      w.onerror = () => this.fallBack();
      this.worker = w;
      return w;
    } catch {
      this.workerFailed = true;
      return undefined;
    }
  }

  private viaWorker(w: Worker, graph: ElkNode): Promise<ElkNode> {
    const id = ++this.seq;
    return new Promise<ElkNode>((resolve, reject) => {
      const timer = setTimeout(() => this.fallBack(), 15000);
      this.pending.set(id, { resolve, reject, graph, timer });
      w.postMessage({ id, graph });
    });
  }

  /** Worker unusable: stop using it and finish every pending layout on the main thread. */
  private fallBack(): void {
    this.workerFailed = true;
    this.worker?.terminate();
    this.worker = undefined;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) {
      clearTimeout(p.timer);
      this.mainThread().then(elk => elk.layout(p.graph)).then(p.resolve, e => p.reject(e instanceof Error ? e : new Error(String(e))));
    }
  }

  private async mainThread(): Promise<ElkLike> {
    if (!this.main) {
      const mod: any = await import('elkjs/lib/elk.bundled.js');
      const Elk = mod.default ?? mod;
      this.main = new Elk() as ElkLike;
    }
    return this.main;
  }
}
