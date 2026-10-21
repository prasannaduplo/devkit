import { describe, expect, it } from 'vitest';
import { nodeDetails } from '../src/app/model/details';
import { GraphIndex } from '../src/app/model/graph-index';
import { iconFor } from '../src/app/model/layout';
import { relatedResources } from '../src/app/model/related';
import { computeView, sublabel } from '../src/app/model/zoom';
import { hubFixture } from './fixture';

// The synthetic hub's invented workloads (backend tests/SyntheticWorkloads.cs) through zoom, side panel and related.
const idx = new GraphIndex(hubFixture().graph);
const byName = (kind: string, name: string) => idx.graph.nodes.find(n => n.kind === kind && n.name === name)!;

describe('workloads on the map', () => {
  const prod = byName('network', 'prod-ue1');

  it('clusters at L2, namespaces / services / ingresses / Lambda at L3, pods / tasks / policies at L4', () => {
    const l2 = computeView(idx, 2).nodes.map(n => n.kind);
    expect(l2).toContain('k8s-cluster');
    expect(l2).toContain('ecs-cluster');
    expect(l2).not.toContain('k8s-namespace');
    const l3 = computeView(idx, 3).nodes.map(n => n.kind);
    for (const k of ['k8s-namespace', 'k8s-service', 'ingress', 'ecs-service', 'lambda-function']) expect(l3).toContain(k);
    expect(l3).not.toContain('pod');
    const l4 = computeView(idx, 4, prod.id).nodes;
    expect(l4.some(n => n.kind === 'pod')).toBe(true);
    expect(l4.some(n => n.kind === 'network-policy')).toBe(true);
    expect(l4.some(n => n.kind === 'ecs-task')).toBe(true);
  });

  it('a namespace with more than 12 pods folds them per owner at L4; focusing the namespace expands them', () => {
    const batch = byName('k8s-namespace', 'batch');
    const v = computeView(idx, 4, prod.id);
    const agg = v.nodes.find(n => n.aggregate && n.parentId === batch.id)!;
    expect(agg.label).toBe('worker ×14');
    expect(agg.sublabel).toBe('Deployment');
    expect(iconFor(agg)).toBe('pod');
    expect(v.nodes.filter(n => n.kind === 'pod' && !n.aggregate && n.parentId === batch.id)).toHaveLength(0);
    // the web namespace (5 pods) is not folded
    expect(v.nodes.filter(n => n.kind === 'pod' && n.parentId === byName('k8s-namespace', 'web').id)).toHaveLength(5);
    // edges of folded pods attach to the aggregate (runs-on → the node ENI)
    expect(v.edges.some(e => e.from === agg.id)).toBe(true);
    const ids = new Set(v.nodes.map(n => n.id));
    for (const e of v.edges) { expect(ids.has(e.from)).toBe(true); expect(ids.has(e.to)).toBe(true); }

    const expanded = computeView(idx, 4, batch.id);
    expect(expanded.nodes.filter(n => n.kind === 'pod' && !n.aggregate)).toHaveLength(14);
    expect(expanded.nodes.some(n => n.aggregate)).toBe(false);
  });

  it('sublabels', () => {
    expect(sublabel(byName('k8s-service', 'api'))).toBe('LoadBalancer · internet-facing');
    expect(sublabel(byName('pod', 'frontend-7d4b9c-00000'))).toBe('10.20.1.11');
    expect(sublabel(byName('k8s-cluster', 'legacy-eks'))).toBe('not readable');
    expect(sublabel(byName('ecs-service', 'orders'))).toBe('2/2 running');
  });
});

describe('workloads in the side panel', () => {
  it('service: ports, selected pods, load balancer', () => {
    const [ports, pods, lb] = nodeDetails(idx, byName('k8s-service', 'api'));
    expect(ports.rows[0].cells).toEqual(['https', 'TCP/443', '8443', '31443']);
    expect(pods.title).toContain('app=api');
    expect(pods.rows).toHaveLength(2);
    expect(lb.rows[0].cells[0]).toBe('api-nlb');
    expect(lb.rows[0].tone).toBe('warn');
  });

  it('ingress rules link to their service; network policy shows rules; pod shows containers and placement', () => {
    const [rules] = nodeDetails(idx, byName('ingress', 'frontend'));
    expect(rules.rows[0].cells).toEqual(['shop.example.com', '/', 'frontend', '80']);
    expect(rules.rows[0].nodeId).toBe(byName('k8s-service', 'frontend').id);

    const [sel, ing, eg] = nodeDetails(idx, byName('network-policy', 'web-default'));
    expect(sel.rows).toHaveLength(5);
    expect(ing.rows[0].cells).toEqual(['1', 'ipBlock 10.20.0.0/16', 'TCP/8080']);
    expect(eg.rows.map(r => r.cells[1])).toEqual(['ipBlock 0.0.0.0/0 except 169.254.169.254/32', 'namespaces: kubernetes.io/metadata.name=kube-system']);

    const [containers, placement, pols] = nodeDetails(idx, byName('pod', 'worker-9a8b7c-00000'));
    expect(containers.rows[0].cells).toEqual(['worker', 'registry.example.com/worker:1.0']);
    expect(placement.rows.find(r => r.cells[0] === 'Runs on')!.nodeId).toContain('eni-node-1');
    expect(pols.rows).toHaveLength(0);
    expect(pols.empty).toContain('No NetworkPolicy');
  });

  it('ECS service and Lambda function', () => {
    const [tasks, lbs] = nodeDetails(idx, byName('ecs-service', 'orders'));
    expect(tasks.rows).toHaveLength(2);
    expect(tasks.rows.some(r => r.tone === 'warn')).toBe(true);
    expect(lbs.rows[0].cells[0]).toBe('web-alb');
    const [subnets, sgs, enis] = nodeDetails(idx, byName('lambda-function', 'nightly-report'));
    expect(subnets.rows[0].cells[2]).toBe('direct');
    expect(subnets.rows[0].tone).toBe('warn');
    expect(sgs.rows[0].cells[0]).toBe('lambda');
    expect(enis.rows).toHaveLength(1);
  });

  it('related resources name the new edges', () => {
    const titles = relatedResources(idx, byName('pod', 'frontend-7d4b9c-00000')).map(g => g.title);
    expect(titles.some(t => t.startsWith('Runs on'))).toBe(true);
    expect(titles.some(t => t.startsWith('Selected by'))).toBe(true);
    expect(titles.some(t => t.startsWith('Exposed by'))).toBe(true);
    const svc = relatedResources(idx, byName('k8s-service', 'frontend')).map(g => g.title);
    expect(svc.some(t => t.startsWith('Selects pods (3)'))).toBe(true);
    expect(svc.some(t => t.startsWith('Fronted by'))).toBe(true);
  });
});
