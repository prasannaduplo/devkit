import { describe, expect, it } from 'vitest';
import type { GraphNode, NetworkGraph } from '../src/app/model/api-types';
import { GraphIndex } from '../src/app/model/graph-index';
import {
  dnsData, egressRows, filterInventory, findingRows, flowLogRows, hubRows, inventoryRows, peeringRows, toCsv, vpnRows,
} from '../src/app/model/tables';
import { hubFixture } from './fixture';

const fx = hubFixture();
const idx = new GraphIndex(fx.graph);

describe('tables on the synthetic hub', () => {
  it('egress: one row per member subnet with class, target and NAT IPs', () => {
    const rows = egressRows(idx);
    expect(rows).toHaveLength(5);
    const prod = rows.find(r => r.network === 'prod-ue1')!;
    expect(prod.egress).toBe('via-hub');
    expect(prod.target).toBe('hub-egress-tgw');
    const priv = rows.find(r => r.subnet === 'private-1a')!;
    expect(priv.egress).toBe('via-nat');
    expect(priv.publicIps).toContain('203.0.113.10');
    expect(rows.find(r => r.subnet === 'public-1a')!.egressText).toBe('Direct to internet gateway');
  });

  it('vpn: one row per connection, degraded flagged', () => {
    const rows = vpnRows(idx);
    expect(rows).toHaveLength(10);
    const bad = rows.filter(r => r.severity === 'warn');
    expect(bad.map(r => r.name)).toEqual(['Site E 2']);
    expect(bad[0].tunnels).toBe('1/2 up');
    expect(bad[0].attachedTo).toBe('domain-c-tgw');
    expect(bad[0].customerGateway).toBeTruthy();
    expect(bad[0].cgwIp).toMatch(/^198\.51\.100\./);
  });

  it('transit: hubs with attachment mix and visibility', () => {
    const rows = hubRows(idx);
    expect(rows).toHaveLength(7);
    const egressHub = rows.find(r => r.name === 'hub-egress-tgw')!;
    expect(egressHub.visibility).toBe('full');
    expect(egressHub.attachments).toContain('vpc');
    expect(egressHub.attachments).toContain('peering 2');
    expect(rows.filter(r => r.visibility === 'stub')).toHaveLength(2);
  });

  it('findings and inventory', () => {
    expect(findingRows(idx).map(f => f.ruleId).sort()).toEqual(['NET-001', 'NET-003']);
    // every finding carries a resource the map can reveal
    for (const f of findingRows(idx)) expect(idx.node(f.nodeId)).toBeTruthy();
    const inv = inventoryRows(idx);
    expect(inv).toHaveLength(fx.graph.nodes.length);
    expect(filterInventory(inv, { kind: 'subnet' })).toHaveLength(5);
    expect(filterInventory(inv, { text: 'bastion' }).length).toBeGreaterThan(0);
    expect(filterInventory(inv, { visibility: 'stub' }).every(r => r.visibility === 'stub')).toBe(true);
  });

  it('flow logs: member networks without logs are reported', () => {
    const rows = flowLogRows(idx);
    expect(rows.map(r => r.network).sort()).toEqual(['egress', 'prod-ue1']);
    expect(rows.every(r => r.coverage === 'none')).toBe(true);
  });
});

describe('tables on hand-made graphs', () => {
  const n = (id: string, kind: string, name: string, extra: Partial<GraphNode> = {}): GraphNode =>
    ({ id, kind, provider: 'aws', nativeId: name, name, visibility: 'full', membership: 'blueprint', attrs: {}, ...extra } as GraphNode);

  it('peering and DNS', () => {
    const g: NetworkGraph = {
      schemaVersion: 1, findings: [],
      nodes: [
        n('p', 'peering', 'pcx-1', { state: 'available', attrs: { requesterVpc: 'vpc-a', requesterAccount: '111111111111', requesterRegion: 'us-east-1', requesterCidr: '10.1.0.0/16', accepterVpc: 'vpc-b', accepterAccount: '222222222222', accepterRegion: 'us-west-2', accepterCidr: '10.2.0.0/16' } }),
        n('net', 'network', 'app'),
        n('z', 'dns-zone', 'corp.internal', { attrs: { private: true } }),
        n('r', 'dns-record', 'db.corp.internal', { parentId: 'z' }),
        n('rule', 'resolver-rule', 'corp', { attrs: { domain: 'corp.example', targetIps: ['192.0.2.53:53'] } }),
      ],
      edges: [{ id: 'e1', from: 'net', to: 'z', kind: 'associated' }, { id: 'e2', from: 'net', to: 'rule', kind: 'associated' }],
    };
    const i = new GraphIndex(g);
    const p = peeringRows(i)[0];
    expect(p.requester).toBe('vpc-a · 111111111111 · us-east-1 · 10.1.0.0/16');
    expect(p.accepter).toContain('us-west-2');
    const d = dnsData(i);
    expect(d.zones[0]).toMatchObject({ name: 'corp.internal', private: 'private', records: 1, networks: 'app' });
    expect(d.rules[0]).toMatchObject({ name: 'corp', domain: 'corp.example', targets: '192.0.2.53:53', networks: 'app' });
  });

  it('CSV quotes commas, quotes and newlines', () => {
    const csv = toCsv([{ a: 'x,y', b: 'say "hi"', c: 'line1\nline2', d: 'plain' }]);
    expect(csv).toBe('a,b,c,d\n"x,y","say ""hi""","line1\nline2",plain\n');
  });
});
