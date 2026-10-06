/**
 * Walks a dot-path into `obj`.
 *
 *   resolvePath({result: {vpc: {vpcId: 'vpc-1'}}}, 'result.vpc.vpcId') // 'vpc-1'
 *   resolvePath({result: {subnets: [{id:'a'},{id:'b'}]}}, 'result.subnets.1.id') // 'b'
 *
 * The caller passes the root object (e.g. `{ result: network.result }`), so
 * template paths walk as written — no prefix stripping.
 */
export function resolvePath(obj: any, dotPath: string): any {
  if (obj == null || !dotPath) return obj;
  return dotPath.split('.').reduce((cur, part) => {
    if (cur == null) return undefined;
    return cur[part];
  }, obj);
}

/**
 * Resolve a `single` field's display value. Supports `isTemplate:true` for
 * `{dot.path}:{other.path}` interpolation and `suffix` appending.
 */
export function resolveSingle(
  data: any,
  field: { value: string; isTemplate?: boolean; suffix?: string },
): string {
  if (!field.value) return '—';

  let val: string;
  if (field.isTemplate) {
    val = field.value.replace(/\{([^}]+)\}/g, (_match, inner) => {
      const v = resolvePath(data, inner);
      return v != null ? String(v) : '—';
    });
  } else {
    const v = resolvePath(data, field.value);
    if (v == null || v === '') return '—';
    val = String(v);
  }

  if (field.suffix) val += field.suffix;
  return val;
}

/**
 * Resolve a `table` or `multi` source into an array. Applies `sourceType:'map'`
 * projection and `filter:{field, value}` pruning.
 */
export function resolveSource(
  data: any,
  field: { source: string; sourceType?: 'map' | 'wrap'; filter?: { field: string; value: any } },
): any[] {
  const src = resolvePath(data, field.source);
  if (src == null) return [];

  if (field.sourceType === 'map') {
    return Object.keys(src).map(k => ({ __key: k, __value: src[k] }));
  }

  if (field.sourceType === 'wrap') {
    return [src];
  }

  if (!Array.isArray(src)) return [];
  if (field.filter) {
    const { field: fname, value } = field.filter;
    return src.filter(item => String(item?.[fname]) === String(value));
  }
  return src;
}

/**
 * Nested dot-path lookup on a table row. Column keys like `Ebs.VolumeId` or
 * `resources.requests.cpu` resolve through the row.
 *
 * Supports `||`-separated fallback paths: the first path that resolves to a
 * non-null, non-empty value wins. Example:
 *   `status.containerStatuses.0.state.waiting.reason||status.phase`
 */
export function resolveRowValue(row: any, colKey: string): string {
  if (!row || !colKey) return '—';
  const candidates = colKey.split('||');
  for (const path of candidates) {
    const v = path.trim().split('.').reduce((cur: any, part: string) => cur?.[part], row);
    if (v != null && v !== '') return String(v);
  }
  return '—';
}
