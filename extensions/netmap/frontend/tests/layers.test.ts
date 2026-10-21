import { describe, expect, it } from 'vitest';
import { GraphIndex } from '../src/app/model/graph-index';
import { DEFAULT_LAYERS, isSystemNamespace, layerVisible, withoutSystemNamespaces } from '../src/app/model/layers';
import { computeView } from '../src/app/model/zoom';
import { hubFixture } from './fixture';

describe('layers', () => {
  const g = hubFixture().graph;

  it('recognises system namespaces', () => {
    for (const n of ['kube-system', 'kube-public', 'kube-node-lease', 'amazon-cloudwatch', 'aws-observability']) expect(isSystemNamespace(n)).toBe(true);
    for (const n of ['default', 'payments', 'ingress-nginx', 'kubernetes-dashboard']) expect(isSystemNamespace(n)).toBe(false);
  });

  it('drops system namespaces, their contents, edges and findings', () => {
    const ns = { id: 'k8s:ns:kube-system', kind: 'k8s-namespace', name: 'kube-system', parentId: undefined } as any;
    const pod = { id: 'k8s:pod:coredns', kind: 'pod', name: 'coredns', parentId: ns.id, attrs: {} } as any;
    const keep = g.nodes[0];
    const out = withoutSystemNamespaces({
      nodes: [keep, ns, pod], edges: [{ id: 'e', kind: 'selects', from: pod.id, to: keep.id }],
      findings: [{ ruleId: 'r', severity: 'warn', message: 'm', nodeIds: [ns.id] }, { ruleId: 'w', severity: 'ok', message: 'blueprint-wide', nodeIds: [] }],
    } as any);
    expect(out.nodes.map(n => n.id)).toEqual([keep.id]);
    expect(out.edges).toEqual([]);
    expect(out.findings!.map(f => f.ruleId)).toEqual(['w']);
  });

  it('hides workload layers by default but always keeps the backbone', () => {
    expect(layerVisible({ kind: 'pod', attrs: { namespace: 'shop' } } as any, DEFAULT_LAYERS)).toBe(false);
    expect(layerVisible({ kind: 'k8s-cluster' } as any, DEFAULT_LAYERS)).toBe(true);
    expect(layerVisible({ kind: 'load-balancer' } as any, { network: false, kubernetes: true, compute: false })).toBe(true);
    expect(layerVisible({ kind: 'subnet' } as any, { network: false, kubernetes: true, compute: false })).toBe(false);
  });

  it('network layer off leaves no subnets in the view', () => {
    const idx = new GraphIndex(g);
    const v = computeView(idx, 3, undefined, { network: false, kubernetes: true, compute: true });
    expect(v.nodes.some(n => n.kind === 'subnet')).toBe(false);
    expect(v.nodes.some(n => n.kind === 'network')).toBe(true);
  });
});
