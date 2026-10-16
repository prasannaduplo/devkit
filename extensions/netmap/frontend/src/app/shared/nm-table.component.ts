import { Component, computed, input, output, signal } from '@angular/core';

export interface NmColumn {
  key: string;
  label: string;
  mono?: boolean;
  badge?: boolean;
  width?: string;
}

/** Sortable read-only table used by the detail tabs. Rows are plain objects; a `severity` field tints the row. */
@Component({
  selector: 'nm-table',
  styles: [`
    .nm-table-wrap { overflow-x: auto; }
    .nm-table { width: 100%; font-size: .86rem; border-collapse: collapse; }
    .nm-table th { font-weight: 600; color: #6e6b7b; padding: .5rem .75rem; border-bottom: 1px solid #ebe9f1; white-space: nowrap; cursor: pointer; user-select: none; }
    .nm-table td { padding: .45rem .75rem; border-bottom: 1px solid #f3f2f7; vertical-align: top; }
    .nm-table tr.clickable { cursor: pointer; }
    .nm-table tr.clickable:hover td { background: rgba(13, 143, 158, .06); }
    .nm-table tr.row-bad td:first-child { box-shadow: inset 3px 0 0 #d6344c; }
    .nm-table tr.row-warn td:first-child { box-shadow: inset 3px 0 0 #d08a1e; }
    .nm-table tr.row-stub td { color: #8a8797; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .8rem; }
    .nm-badge { font-size: .72rem; font-weight: 600; padding: .1rem .45rem; border-radius: .25rem; background: #eef1f4; color: #4a5560; white-space: nowrap; }
    .nm-badge[data-v="bad"], .nm-badge[data-v="down"], .nm-badge[data-v="failed"], .nm-badge[data-v="denied"], .nm-badge[data-v="abandoned"] { background: #fdeaea; color: #b42318; }
    .nm-badge[data-v="warn"], .nm-badge[data-v="partial"], .nm-badge[data-v="not-readable"], .nm-badge[data-v="none"], .nm-badge[data-v="some subnets"] { background: #fbf1de; color: #9a5b0c; }
    .nm-badge[data-v="ok"], .nm-badge[data-v="up"], .nm-badge[data-v="complete"], .nm-badge[data-v="available"], .nm-badge[data-v="full"], .nm-badge[data-v="unchanged"], .nm-badge[data-v="network"], .nm-badge[data-v="all subnets"] { background: #e3f6ea; color: #1d7a3e; }
    .nm-empty { color: #8a8797; padding: .75rem 0; margin: 0; }
  `],
  template: `
    @if (rows().length === 0) {
      <p class="nm-empty">{{ empty() }}</p>
    } @else {
      <div class="nm-table-wrap">
        <table class="nm-table">
          <thead>
            <tr>
              @for (c of columns(); track c.key) {
                <th [style.width]="c.width" (click)="sortBy(c.key)">
                  {{ c.label }}
                  @if (sortKey() === c.key) { <span>{{ asc() ? '▲' : '▼' }}</span> }
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (r of sorted(); track r['id'] ?? $index) {
              <tr [class]="'row-' + (r['severity'] ?? 'ok')" [class.clickable]="clickable()" (click)="rowClick.emit(r)">
                @for (c of columns(); track c.key) {
                  <td [class.mono]="c.mono">
                    @if (c.badge) {
                      <span class="nm-badge" [attr.data-v]="r[c.key]">{{ r[c.key] }}</span>
                    } @else {
                      {{ r[c.key] }}
                    }
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class NmTableComponent {
  readonly columns = input.required<NmColumn[]>();
  readonly rows = input.required<Record<string, any>[]>();
  readonly empty = input('Nothing to show.');
  readonly clickable = input(false);
  readonly rowClick = output<Record<string, any>>();

  protected readonly sortKey = signal<string | null>(null);
  protected readonly asc = signal(true);
  protected readonly sorted = computed(() => {
    const key = this.sortKey();
    const rows = [...this.rows()];
    if (!key) return rows;
    const dir = this.asc() ? 1 : -1;
    return rows.sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? ''), undefined, { numeric: true }) * dir);
  });

  protected sortBy(key: string): void {
    if (this.sortKey() === key) this.asc.set(!this.asc());
    else {
      this.sortKey.set(key);
      this.asc.set(true);
    }
  }
}
