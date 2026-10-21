import { BlueprintMember, NetworkBlueprintSpec } from './api-types';
import { GraphIndex, str } from './graph-index';
import { OutsideRef } from './path';
import { memberKey } from './picker';

// "The path leaves the blueprint here — add that network and rescan." Framework-free.

/** Account of a graph node: its own fields, else its account container. */
export function nodeAccount(idx: GraphIndex, nodeId: string): string | undefined {
  const n = idx.node(nodeId);
  if (!n) return undefined;
  return n.ownerAccount ?? n.account ?? idx.ancestorOfKind(n.id, 'account')?.nativeId;
}

/**
 * The workspace scope that already reaches `account`: a current member whose network sits in that account.
 * WorkspaceScope carries no account id, so the blueprint's own members are the only mapping we have.
 */
export function scopeForAccount(idx: GraphIndex, members: BlueprintMember[], account: string | undefined): string | undefined {
  if (!account) return undefined;
  for (const m of members) {
    const net = idx.graph.nodes.find(n => n.kind === 'network' && n.nativeId === m.networkId && (!n.region || n.region === m.region));
    if (net && nodeAccount(idx, net.id) === account) return m.scopeId;
  }
  return undefined;
}

/** The member to add for an outside network, or null when the outside node is not an addable network. */
export function outsideMember(idx: GraphIndex, outside: OutsideRef, scopeId: string): BlueprintMember | null {
  const n = idx.node(outside.nodeId);
  if (!n || n.kind !== 'network' || !outside.networkNativeId || !scopeId) return null;
  const region = n.region ?? outside.region;
  if (!region || region === 'global') return null;
  const hint = str(n.attrs?.['nameHint']);
  const display = hint || (n.name && n.name !== n.nativeId ? n.name : '') || n.nativeId;
  return { scopeId, provider: n.provider || 'aws', region, networkId: n.nativeId, displayName: display, cidrs: [...(n.cidrs ?? [])] };
}

/** PATCH replaces the whole spec: the full current spec plus the member, with a new scan request. */
export function specWithMember(spec: NetworkBlueprintSpec, member: BlueprintMember, now = new Date()): NetworkBlueprintSpec {
  const exists = (spec.members ?? []).some(m => memberKey(m) === memberKey(member));
  return { ...spec, members: exists ? [...spec.members] : [...(spec.members ?? []), member], scanRequestedAt: now.toISOString() };
}
