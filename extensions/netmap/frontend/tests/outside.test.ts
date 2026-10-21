import { describe, expect, it } from 'vitest';
import { GraphIndex } from '../src/app/model/graph-index';
import { outsideMember, scopeForAccount, specWithMember } from '../src/app/model/outside';
import { hubFixture } from './fixture';

describe('outside network → blueprint member', () => {
  const fx = hubFixture();
  const idx = new GraphIndex(fx.graph);
  const members = [
    { scopeId: 'scope-hub', provider: 'aws', region: 'us-east-1', networkId: 'vpc-egress' },
    { scopeId: 'scope-apps', provider: 'aws', region: 'us-east-1', networkId: 'vpc-prod' },
  ];
  const stub = { nodeId: 'aws:-:us-east-1:network:vpc-shared-services', account: '222222222222', region: 'us-east-1', networkNativeId: 'vpc-shared-services' };

  it('maps the outside account to the scope of a member in the same account', () => {
    expect(scopeForAccount(idx, members, '222222222222')).toBe('scope-apps');
    expect(scopeForAccount(idx, members, '111111111111')).toBe('scope-hub');
    expect(scopeForAccount(idx, members, '333333333333')).toBeUndefined();
    expect(scopeForAccount(idx, members, undefined)).toBeUndefined();
  });

  it('builds the member from the stub network (name hint, region)', () => {
    expect(outsideMember(idx, stub, 'scope-apps')).toEqual({
      scopeId: 'scope-apps', provider: 'aws', region: 'us-east-1', networkId: 'vpc-shared-services', displayName: 'shared-services', cidrs: [],
    });
    expect(outsideMember(idx, { nodeId: 'aws:-:us-west-1:hub:tgw-colo' }, 'scope-apps')).toBeNull();
    expect(outsideMember(idx, stub, '')).toBeNull();
  });

  it('sends the full spec plus the member and a scan request; never duplicates', () => {
    const spec = { purpose: 'p', labels: { team: 'net' }, members, scopeIds: ['scope-hub'] };
    const m = outsideMember(idx, stub, 'scope-apps')!;
    const next = specWithMember(spec, m, new Date('2026-01-02T03:04:05Z'));
    expect(next.purpose).toBe('p');
    expect(next.labels).toEqual({ team: 'net' });
    expect(next.scopeIds).toEqual(['scope-hub']);
    expect(next.members).toHaveLength(3);
    expect(next.scanRequestedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(specWithMember(next, m).members).toHaveLength(3);
    expect(spec.members).toHaveLength(2);
  });
});
