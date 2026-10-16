import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  NetworkBlueprint, NetworkBlueprintSpec, NetworkGraph, PickerVpc, SnapshotHeader, WorkspaceScope,
} from './model/api-types';

export const REMOTE_DuploHttpClient = 'REMOTE_DuploHttpClient';
export const REMOTE_UserSession = 'REMOTE_UserSession';

// MUST equal manifest resources[].restSegment AND the controller [Route] — see reference/00-naming.md.
const REST_SEGMENT = 'extensions/networkblueprints';
const LEGACY_SEGMENT = 'extensions/networkmaps';

export interface LegacyNetworkMap { id: string; name: string; spec?: { region?: string } }

@Injectable({ providedIn: 'root' })
export class NetworkBlueprintService {
  private readonly http = inject<any>(REMOTE_DuploHttpClient as any);
  private readonly session = inject<any>(REMOTE_UserSession as any);

  workspaceId(): string {
    return this.session?.tenant?.TenantId ?? '';
  }

  private wsBase(): string {
    return `/v1/aiservicedesk/user/data/workspaces/${this.workspaceId()}`;
  }

  private base(): string {
    return `${this.wsBase()}/environment/${REST_SEGMENT}`;
  }

  // DuploHttpClient does not unwrap the ApiResponse envelope — normalize `{data:…}` and bare bodies.
  private unwrap = (r: any) => (r && r.data !== undefined ? r.data : r);
  private items = (r: any) => {
    const d = this.unwrap(r);
    return d?.items ?? d ?? [];
  };

  list(): Observable<NetworkBlueprint[]> {
    return this.http.get(this.base()).pipe(map((r: any) => this.items(r) as NetworkBlueprint[]));
  }

  get(id: string): Observable<NetworkBlueprint> {
    return this.http.get(`${this.base()}/${id}`).pipe(map((r: any) => this.unwrap(r)));
  }

  create(name: string, spec: NetworkBlueprintSpec): Observable<NetworkBlueprint> {
    return this.http.post(this.base(), { name, spec }).pipe(map((r: any) => this.unwrap(r)));
  }

  /** PATCH replaces the whole spec on this platform — always pass the complete spec. */
  update(id: string, spec: NetworkBlueprintSpec): Observable<NetworkBlueprint> {
    return this.http.patch(`${this.base()}/${id}`, { spec }).pipe(map((r: any) => this.unwrap(r)));
  }

  /** "Scan now" = the full spec with a new scanRequestedAt. */
  scanNow(item: NetworkBlueprint): Observable<NetworkBlueprint> {
    return this.update(item.id, { ...item.spec, scanRequestedAt: new Date().toISOString() });
  }

  delete(id: string): Observable<void> {
    return this.http.delete(`${this.base()}/${id}`);
  }

  scopes(): Observable<WorkspaceScope[]> {
    return this.http.get(`${this.wsBase()}/scopes`).pipe(map((r: any) => this.items(r) as WorkspaceScope[]));
  }

  regions(scopeId: string): Observable<string[]> {
    return this.http.get(`${this.base()}/picker/regions?scopeId=${encodeURIComponent(scopeId)}`).pipe(map((r: any) => this.items(r) as string[]));
  }

  vpcs(scopeId: string, region: string): Observable<PickerVpc[]> {
    const q = `scopeId=${encodeURIComponent(scopeId)}&region=${encodeURIComponent(region)}`;
    return this.http.get(`${this.base()}/picker/vpcs?${q}`).pipe(map((r: any) => this.items(r) as PickerVpc[]));
  }

  snapshots(id: string): Observable<SnapshotHeader[]> {
    return this.http.get(`${this.base()}/${id}/snapshots`).pipe(map((r: any) => this.items(r) as SnapshotHeader[]));
  }

  graph(id: string, snapshotId = 'latest'): Observable<NetworkGraph> {
    return this.http.get(`${this.base()}/${id}/snapshots/${snapshotId}/graph`).pipe(map((r: any) => this.unwrap(r) as NetworkGraph));
  }

  /** v0 single-region maps — only listed so they can be deleted. */
  legacyList(): Observable<LegacyNetworkMap[]> {
    return this.http.get(`${this.wsBase()}/environment/${LEGACY_SEGMENT}`).pipe(map((r: any) => this.items(r) as LegacyNetworkMap[]));
  }

  legacyDelete(id: string): Observable<void> {
    return this.http.delete(`${this.wsBase()}/environment/${LEGACY_SEGMENT}/${id}`);
  }

  static errorMessage(err: any): string {
    return err?.error?.errors || err?.error?.message || err?.error?.Message || err?.message || 'Request failed';
  }
}
