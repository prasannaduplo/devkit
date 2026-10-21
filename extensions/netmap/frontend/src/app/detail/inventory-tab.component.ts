import { Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InventoryRow, filterInventory, toCsv } from '../model/tables';
import { NmColumn, NmTableComponent } from '../shared/nm-table.component';

const COLUMNS: NmColumn[] = [
  { key: 'kindLabel', label: 'Kind' },
  { key: 'name', label: 'Name' },
  { key: 'nativeId', label: 'Id', mono: true },
  { key: 'network', label: 'Network' },
  { key: 'account', label: 'Account', mono: true },
  { key: 'region', label: 'Region', mono: true },
  { key: 'visibility', label: 'Visibility', badge: true },
  { key: 'state', label: 'State' },
  { key: 'tags', label: 'Tags', mono: true },
];

@Component({
  selector: 'nm-inventory-tab',
  imports: [FormsModule, NmTableComponent],
  styles: [`
    .nm-filters { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin-bottom: .75rem; }
    .nm-filters .form-control { max-width: 220px; }
    .nm-count { color: #8a8797; font-size: .85rem; margin-left: auto; }
  `],
  template: `
    <div class="nm-filters">
      <input class="form-control form-control-sm" placeholder="Search name, id, tag…" [ngModel]="text()" (ngModelChange)="text.set($event)" />
      <select class="form-control form-control-sm" [ngModel]="kind()" (ngModelChange)="kind.set($event)">
        <option value="">All kinds</option>
        @for (k of kinds(); track k.kind) { <option [value]="k.kind">{{ k.label }}</option> }
      </select>
      <select class="form-control form-control-sm" [ngModel]="network()" (ngModelChange)="network.set($event)">
        <option value="">All networks</option>
        @for (n of networks(); track n) { <option [value]="n">{{ n }}</option> }
      </select>
      <select class="form-control form-control-sm" [ngModel]="visibility()" (ngModelChange)="visibility.set($event)">
        <option value="">Any visibility</option>
        <option value="full">full</option>
        <option value="partial">partial</option>
        <option value="stub">stub</option>
      </select>
      <button type="button" class="btn btn-sm btn-outline-secondary" (click)="downloadCsv()">Export CSV</button>
      <span class="nm-count">{{ filtered().length }} of {{ rows().length }}</span>
    </div>
    <nm-table [columns]="columns" [rows]="filtered()" [clickable]="true" empty="No resources match." (rowClick)="rowClick.emit($event['id'])" />
  `,
})
export class InventoryTabComponent {
  readonly rows = input.required<InventoryRow[]>();
  readonly fileName = input('network-inventory');
  readonly rowClick = output<string>();

  protected readonly columns = COLUMNS;
  protected readonly text = signal('');
  protected readonly kind = signal('');
  protected readonly network = signal('');
  protected readonly visibility = signal('');

  protected readonly kinds = computed(() => {
    const seen = new Map<string, string>();
    for (const r of this.rows()) seen.set(r.kind, r.kindLabel);
    return [...seen.entries()].map(([kind, label]) => ({ kind, label })).sort((a, b) => a.label.localeCompare(b.label));
  });
  protected readonly networks = computed(() => [...new Set(this.rows().map(r => r.network).filter(Boolean))].sort());
  protected readonly filtered = computed(() =>
    filterInventory(this.rows(), { text: this.text(), kind: this.kind(), network: this.network(), visibility: this.visibility() }));

  protected downloadCsv(): void {
    const blob = new Blob([toCsv(this.filtered() as unknown as Record<string, unknown>[])], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.fileName()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
