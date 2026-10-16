import { BlueprintMember, MemberStatus, PickerVpc, WorkspaceScope } from './api-types';
import { cidrsOverlap } from './cidr';

export interface SelectedMember {
  scopeId: string;
  scopeName: string;
  provider: string;
  region: string;
  networkId: string;
  displayName: string;
  cidrs: string[];
}

export interface ScopeGroup {
  scopeId: string;
  scopeName: string;
  regions: { region: string; members: SelectedMember[] }[];
}

/** Same identity the backend validates on: one VPC once per blueprint, whichever scope it came from. */
export function memberKey(m: { provider: string; region: string; networkId: string }): string {
  return `${m.provider}|${m.region}|${m.networkId}`;
}

export function addVpcs(list: SelectedMember[], scope: WorkspaceScope, region: string, vpcs: PickerVpc[]): SelectedMember[] {
  const keys = new Set(list.map(memberKey));
  const added: SelectedMember[] = [];
  for (const v of vpcs) {
    const m: SelectedMember = { scopeId: scope.id, scopeName: scope.name, provider: 'aws', region, networkId: v.vpcId, displayName: v.name || v.vpcId, cidrs: [...v.cidrs] };
    if (keys.has(memberKey(m))) continue;
    keys.add(memberKey(m));
    added.push(m);
  }
  return [...list, ...added];
}

export function removeMember(list: SelectedMember[], key: string): SelectedMember[] {
  return list.filter(m => memberKey(m) !== key);
}

export function groupMembers(list: SelectedMember[]): ScopeGroup[] {
  const groups = new Map<string, ScopeGroup>();
  for (const m of list) {
    if (!groups.has(m.scopeId)) groups.set(m.scopeId, { scopeId: m.scopeId, scopeName: m.scopeName, regions: [] });
    const g = groups.get(m.scopeId)!;
    let r = g.regions.find(x => x.region === m.region);
    if (!r) {
      r = { region: m.region, members: [] };
      g.regions.push(r);
    }
    r.members.push(m);
  }
  const result = [...groups.values()].sort((a, b) => a.scopeName.localeCompare(b.scopeName));
  for (const g of result) {
    g.regions.sort((a, b) => a.region.localeCompare(b.region));
    for (const r of g.regions) r.members.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  return result;
}

/** member key → "CIDR x overlaps <other>" for every member whose CIDR overlaps another selected member's. */
export function overlapWarnings(list: SelectedMember[]): Map<string, string> {
  const warnings = new Map<string, string>();
  for (const a of list) {
    for (const b of list) {
      if (a === b || warnings.has(memberKey(a))) continue;
      const hit = a.cidrs.find(ca => b.cidrs.some(cb => cidrsOverlap(ca, cb)));
      if (hit) warnings.set(memberKey(a), `CIDR ${hit} overlaps ${b.displayName}`);
    }
  }
  return warnings;
}

export function toSpecMembers(list: SelectedMember[]): BlueprintMember[] {
  return list.map(m => ({ scopeId: m.scopeId, provider: m.provider, region: m.region, networkId: m.networkId, displayName: m.displayName, cidrs: [...m.cidrs] }));
}

export function fromSpec(members: BlueprintMember[], scopes: WorkspaceScope[], statuses: MemberStatus[]): SelectedMember[] {
  return members.map(m => {
    const st = statuses.find(s => s.networkId === m.networkId && s.region === m.region && s.scopeId === m.scopeId);
    return {
      scopeId: m.scopeId,
      scopeName: scopes.find(s => s.id === m.scopeId)?.name ?? m.scopeId,
      provider: m.provider || 'aws',
      region: m.region,
      networkId: m.networkId,
      displayName: st?.displayName || m.displayName || m.networkId,
      cidrs: st?.cidrs?.length ? [...st.cidrs] : [...(m.cidrs ?? [])],
    };
  });
}

export function parseLabels(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of text.split(/[,\n]/)) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq <= 0) throw new Error(`"${p}" is not key=value`);
    result[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  }
  return result;
}

export function formatLabels(labels: Record<string, string> | undefined): string {
  return Object.entries(labels ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
}
