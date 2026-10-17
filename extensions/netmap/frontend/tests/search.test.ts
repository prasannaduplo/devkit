import { describe, expect, it } from 'vitest';
import { GraphIndex } from '../src/app/model/graph-index';
import { search } from '../src/app/model/search';
import { hubFixture } from './fixture';
import { id, withPublicLb, world } from './world';

describe('search — synthetic hub fixture', () => {
  const idx = new GraphIndex(hubFixture().graph);

  it('exact native id ranks first', () => {
    const hits = search(idx, 'nat-egress-1a');
    expect(hits[0].nodeId).toBe('aws:-:us-east-1:nat-gateway:nat-egress-1a');
    expect(hits[0].why).toBe('id');
  });

  it('name prefix and contains', () => {
    const hits = search(idx, 'private-1');
    expect(hits.slice(0, 2).map(h => h.label).sort()).toEqual(['private-1a', 'private-1b']);
    expect(hits[0].sub).toContain('Subnet');
    expect(search(idx, 'egress-tgw').some(h => h.label === 'hub-egress-tgw')).toBe(true);
  });

  it('IP → interface, public IP node, then the smallest containing subnet', () => {
    const eni = search(idx, '10.100.101.20');
    expect(eni[0].nodeId).toBe('aws:-:us-east-1:network-interface:eni-bastion');
    expect(eni[1].nodeId).toBe('aws:-:us-east-1:subnet:subnet-egress-pub-1a');
    expect(eni.find(h => h.nodeId === 'aws:-:us-east-1:network:vpc-egress')).toBeTruthy();
    expect(search(idx, '203.0.113.10')[0].nodeId).toBe('aws:-:us-east-1:public-ip:eipalloc-egress-1a');
    expect(search(idx, '10.100.2.99')[0].nodeId).toBe('aws:-:us-east-1:subnet:subnet-egress-priv-1b');
  });

  it('CIDR → subnet / network', () => {
    expect(search(idx, '10.100.1.0/24')[0].nodeId).toBe('aws:-:us-east-1:subnet:subnet-egress-priv-1a');
    expect(search(idx, '10.20.0.0/16')[0].nodeId).toBe('aws:-:us-east-1:network:vpc-prod');
  });

  it('empty and nonsense queries', () => {
    expect(search(idx, '  ')).toEqual([]);
    expect(search(idx, 'zzz-nothing-here')).toEqual([]);
  });
});

describe('search — DNS', () => {
  const w = withPublicLb(world());
  const zone = w.node('dns-zone', 'Z1', { name: 'example.test', region: 'global' });
  const rec = w.node('dns-record', 'Z1/app.example.test./A/', { name: 'app.example.test', parentId: zone.id, region: 'global', attrs: { recordType: 'A' } });
  w.edge(rec.id, 'resolves-to', id('load-balancer', 'lb-pub'));
  const idx = new GraphIndex(w.graph());

  it('a record name finds what it resolves to', () => {
    const hits = search(idx, 'app.example.test');
    expect(hits[0].nodeId).toBe(id('load-balancer', 'lb-pub'));
    expect(hits[0].why).toBe('app.example.test resolves here');
    expect(hits[1].nodeId).toBe(rec.id);
  });

  it('an unknown name inside a zone finds the zone', () => {
    const hits = search(idx, 'other.example.test');
    expect(hits[0].nodeId).toBe(zone.id);
    expect(hits[0].why).toBe('in zone example.test');
  });
});
