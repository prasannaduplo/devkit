import { describe, expect, it } from 'vitest';
import { KINDS, kindInfo } from '../src/app/model/kinds';
import { backendKinds } from './fixture';

describe('kind registry mirror', () => {
  it('matches the backend registry exactly', () => {
    const sorted = <T extends { kind: string }>(a: T[]) => [...a].sort((x, y) => x.kind.localeCompare(y.kind));
    expect(sorted(KINDS)).toEqual(sorted(backendKinds()));
  });

  it('falls back for unknown kinds like the backend does', () => {
    expect(kindInfo('quantum-router')).toEqual({ kind: 'quantum-router', level: 3, icon: 'generic', label: 'quantum-router', container: false });
  });
});
