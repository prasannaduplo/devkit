import { GraphEdge, GraphNode, NetworkGraph } from './api-types';

/** Read-side lookups over a snapshot graph. Built once per loaded graph. */
export class GraphIndex {
  private readonly byId = new Map<string, GraphNode>();
  private readonly outMap = new Map<string, GraphEdge[]>();
  private readonly inMap = new Map<string, GraphEdge[]>();
  private readonly childMap = new Map<string, GraphNode[]>();

  constructor(readonly graph: NetworkGraph) {
    for (const n of graph.nodes) this.byId.set(n.id, n);
    for (const e of graph.edges) {
      push(this.outMap, e.from, e);
      push(this.inMap, e.to, e);
    }
    for (const n of graph.nodes) if (n.parentId && this.byId.has(n.parentId)) push(this.childMap, n.parentId, n);
  }

  node(id: string): GraphNode | undefined {
    return this.byId.get(id);
  }

  out(id: string, kind?: string): GraphEdge[] {
    const list = this.outMap.get(id) ?? [];
    return kind ? list.filter(e => e.kind === kind) : list;
  }

  in(id: string, kind?: string): GraphEdge[] {
    const list = this.inMap.get(id) ?? [];
    return kind ? list.filter(e => e.kind === kind) : list;
  }

  children(id: string): GraphNode[] {
    return this.childMap.get(id) ?? [];
  }

  ofKind(kind: string): GraphNode[] {
    return this.graph.nodes.filter(n => n.kind === kind);
  }

  byName(kind: string, name: string): GraphNode | undefined {
    return this.graph.nodes.find(n => n.kind === kind && n.name === name);
  }

  /** Parent chain, nearest first. Cycle-safe. */
  ancestors(id: string): GraphNode[] {
    const result: GraphNode[] = [];
    const seen = new Set<string>([id]);
    let current = this.byId.get(id)?.parentId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const n = this.byId.get(current);
      if (!n) break;
      result.push(n);
      current = n.parentId;
    }
    return result;
  }

  ancestorOfKind(id: string, kind: string): GraphNode | undefined {
    return this.ancestors(id).find(a => a.kind === kind);
  }

  isAncestor(ancestorId: string, id: string): boolean {
    return this.ancestors(id).some(a => a.id === ancestorId);
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

export function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
