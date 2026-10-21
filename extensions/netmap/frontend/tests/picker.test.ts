import { describe, expect, it } from 'vitest';
import type { PickerVpc, WorkspaceScope } from '../src/app/model/api-types';
import {
  addVpcs, formatLabels, fromSpec, groupMembers, memberKey, overlapWarnings, parseLabels, removeMember, toSpecMembers,
} from '../src/app/model/picker';

const hubScope: WorkspaceScope = { id: 's-hub', name: 'network-hub' };
const appScope: WorkspaceScope = { id: 's-app', name: 'prod-apps' };
const vpc = (vpcId: string, name: string, cidr: string): PickerVpc => ({ vpcId, name, cidrs: [cidr], subnetCount: 2, tags: {}, isDefault: false });

describe('picker selection', () => {
  it('adds without duplicates — the same VPC under another scope is rejected too', () => {
    let list = addVpcs([], hubScope, 'us-east-1', [vpc('vpc-1', 'egress', '10.100.0.0/16')]);
    list = addVpcs(list, hubScope, 'us-east-1', [vpc('vpc-1', 'egress', '10.100.0.0/16'), vpc('vpc-2', 'inspection', '10.101.0.0/16')]);
    list = addVpcs(list, appScope, 'us-east-1', [vpc('vpc-1', 'egress', '10.100.0.0/16')]);
    expect(list.map(m => m.networkId)).toEqual(['vpc-1', 'vpc-2']);
    expect(memberKey(list[0])).toBe('aws|us-east-1|vpc-1');
  });

  it('groups by scope then region and removes by key', () => {
    let list = addVpcs([], appScope, 'us-west-2', [vpc('vpc-9', 'prod-uw2', '10.20.0.0/16')]);
    list = addVpcs(list, hubScope, 'us-east-1', [vpc('vpc-1', 'egress', '10.100.0.0/16')]);
    list = addVpcs(list, appScope, 'us-east-1', [vpc('vpc-8', 'prod-ue1', '10.20.0.0/16')]);
    const groups = groupMembers(list);
    expect(groups.map(g => g.scopeName)).toEqual(['network-hub', 'prod-apps']);
    expect(groups[1].regions.map(r => r.region)).toEqual(['us-east-1', 'us-west-2']);
    expect(removeMember(list, 'aws|us-west-2|vpc-9')).toHaveLength(2);
  });

  it('warns on CIDR overlap', () => {
    let list = addVpcs([], appScope, 'us-east-1', [vpc('vpc-8', 'prod-ue1', '10.20.0.0/16')]);
    list = addVpcs(list, appScope, 'us-west-2', [vpc('vpc-9', 'prod-uw2', '10.20.0.0/16')]);
    list = addVpcs(list, hubScope, 'us-east-1', [vpc('vpc-1', 'egress', '10.100.0.0/16')]);
    const w = overlapWarnings(list);
    expect(w.get('aws|us-west-2|vpc-9')).toBe('CIDR 10.20.0.0/16 overlaps prod-ue1');
    expect(w.get('aws|us-east-1|vpc-8')).toBe('CIDR 10.20.0.0/16 overlaps prod-uw2');
    expect(w.has('aws|us-east-1|vpc-1')).toBe(false);
  });

  it('round-trips to spec members and back', () => {
    const list = addVpcs([], hubScope, 'us-east-1', [vpc('vpc-1', 'egress', '10.100.0.0/16')]);
    const spec = toSpecMembers(list);
    expect(spec).toEqual([{ scopeId: 's-hub', provider: 'aws', region: 'us-east-1', networkId: 'vpc-1', displayName: 'egress', cidrs: ['10.100.0.0/16'] }]);
    const back = fromSpec(spec, [hubScope], [{ scopeId: 's-hub', region: 'us-east-1', networkId: 'vpc-1', status: 'ok', displayName: 'egress-renamed', cidrs: ['10.100.0.0/16'] }]);
    expect(back[0]).toMatchObject({ scopeName: 'network-hub', displayName: 'egress-renamed' });
  });

  it('parses and formats labels', () => {
    expect(parseLabels('env=prod, app=payments\nowner = networking')).toEqual({ env: 'prod', app: 'payments', owner: 'networking' });
    expect(parseLabels('  ')).toEqual({});
    expect(() => parseLabels('env')).toThrow(/key=value/);
    expect(formatLabels({ env: 'prod', app: 'payments' })).toBe('env=prod, app=payments');
  });
});
