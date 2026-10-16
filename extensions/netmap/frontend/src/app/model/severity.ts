import { GraphIndex, str } from './graph-index';
import { ViewEdge, ViewNode } from './zoom';

export type Sev = 'ok' | 'warn' | 'bad' | 'stub';
type Flag = 'warn' | 'bad';

const RANK: Record<Sev, number> = { ok: 0, stub: 0, warn: 1, bad: 2 };
const INTERNET = 'net:-:global:external:internet';

export interface SeverityContext {
  nodeSev: Map<string, Flag>;
  edgeSev: Map<string, Flag>;
  chokepoints: Set<string>;
}

export function buildSeverity(idx: GraphIndex): SeverityContext {
  const nodeSev = new Map<string, Flag>();
  const edgeSev = new Map<string, Flag>();
  const raise = (m: Map<string, Flag>, id: string, s: Flag) => {
    const cur = m.get(id);
    if (!cur || RANK[s] > RANK[cur]) m.set(id, s);
  };

  for (const f of idx.graph.findings ?? []) {
    if (f.severity !== 'warn' && f.severity !== 'bad') continue;
    for (const id of f.nodeIds) {
      raise(nodeSev, id, f.severity);
      for (const a of idx.ancestors(id)) raise(nodeSev, a.id, f.severity);
    }
    for (const id of f.edgeIds) raise(edgeSev, id, f.severity);
  }
  for (const e of idx.graph.edges) {
    if (e.kind !== 'allows') continue;
    if (e.from === INTERNET) raise(edgeSev, e.id, 'bad');
    else if (e.to === INTERNET) raise(edgeSev, e.id, 'warn');
  }
  return { nodeSev, edgeSev, chokepoints: chokepoints(idx) };
}

export function edgeSeverity(e: ViewEdge, nodes: Map<string, ViewNode>, ctx: SeverityContext): Sev {
  let worst: Sev = 'ok';
  for (const id of e.edgeIds) {
    const s = ctx.edgeSev.get(id);
    if (s && RANK[s] > RANK[worst]) worst = s;
  }
  if (worst !== 'ok') return worst;
  const from = nodes.get(e.from);
  const to = nodes.get(e.to);
  if (from?.aggregate && from.aggregate.degraded > 0) return 'warn';
  if (from?.kind === 'vpn-connection' && ctx.nodeSev.get(from.id) === 'warn') return 'warn';
  if (from?.visibility === 'stub' || to?.visibility === 'stub') return 'stub';
  return 'ok';
}

export function nodeSeverity(n: ViewNode, ctx: SeverityContext): Sev {
  if (n.aggregate) return n.aggregate.degraded > 0 ? 'warn' : 'ok';
  if (n.visibility === 'stub') return 'stub';
  return ctx.nodeSev.get(n.id) ?? 'ok';
}

export function chokepoints(idx: GraphIndex): Set<string> {
  const viaHub = new Map<string, Set<string>>();   // hub id -> networks egressing through it
  const selfEgress = new Set<string>();             // networks with a direct / via-nat subnet
  for (const s of idx.ofKind('subnet')) {
    const cls = str(s.attrs?.['egress']);
    const net = idx.ancestorOfKind(s.id, 'network')?.id;
    if (!net) continue;
    if (cls === 'direct' || cls === 'via-nat') selfEgress.add(net);
    if (cls === 'via-hub' || cls === 'via-hub-partial') {
      const hub = str(s.attrs?.['egressTarget']);
      if (!hub) continue;
      if (!viaHub.has(hub)) viaHub.set(hub, new Set());
      viaHub.get(hub)!.add(net);
    }
  }

  const result = new Set<string>();
  for (const net of idx.ofKind('network')) {
    const hasIgw = idx.out(net.id, 'attaches').some(e => idx.node(e.to)?.kind === 'internet-gateway');
    if (!hasIgw) continue;
    const converging = new Set<string>();
    if (selfEgress.has(net.id)) converging.add(net.id);
    for (const e of idx.out(net.id, 'attaches')) {
      const att = idx.node(e.to);
      if (att?.kind !== 'hub-attachment') continue;
      for (const hubEdge of idx.out(att.id, 'attaches')) for (const other of viaHub.get(hubEdge.to) ?? []) converging.add(other);
    }
    if (converging.size >= 2) result.add(net.id);
  }
  return result;
}
