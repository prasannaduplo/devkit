import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import {
  TemplateField, SingleField, MultiField, TableField, RawField,
  FieldDetails, SubTemplate, TemplateGroup,
  MenuAction, MenuActionEvent,
} from './result-view-template.model';
import { resolvePath, resolveSingle, resolveSource, resolveRowValue } from './path-resolver.util';
import { ResourceDetailModalComponent } from './resource-detail-modal.component';

/**
 * Renders one template field against the passed `data`. Switches on `field.type`:
 *   single → labeled tile (clickable when `details` + `detailSource` are set)
 *   multi  → pill list
 *   table  → Bootstrap table (with optional filter + nested-path columns + drilldown)
 *   raw    → collapsible <pre> with syntax-highlighted JSON
 *
 * Both SingleField and TableField share the same `FieldDetails` drilldown config
 * and the same modal-opening logic via `openDetailModal()`.
 */
@Component({
  selector: 'app-field-renderer',
  templateUrl: './field-renderer.component.html',
  styleUrls: ['./resource-template-view.component.scss'],
  standalone: false,
  // Angular 22 defaults to OnPush; these components assign plain fields from subscribe handlers.
  changeDetection: ChangeDetectionStrategy.Eager
})
export class FieldRendererComponent implements OnInit {
  @Input() field!: TemplateField;
  @Input() data: any;
  @Input() subTemplates?: Record<string, SubTemplate>;
  @Output() menuAction = new EventEmitter<MenuActionEvent>();

  rawOpen = false;

  cardMenus(): MenuAction[] | undefined {
    return (this.field as any).cardMenus;
  }

  onRowMenu(event: MouseEvent, menuId: string, row: any): void {
    event.stopPropagation();
    this.menuAction.emit({ menuId, level: 'row', fieldKey: this.field.key, row });
  }

  onCardMenu(event: MouseEvent, menuId: string): void {
    event.stopPropagation();
    this.menuAction.emit({ menuId, level: 'card', fieldKey: this.field.key });
  }

  constructor(private modalService: NgbModal) {}

  ngOnInit(): void {
    if (this.field.type === 'raw' && (this.field as RawField).expanded) {
      this.rawOpen = true;
    }
  }

  // ── Resolvers delegated to the pure-function util ─────────────────────────

  asSingle(): SingleField  { return this.field as SingleField; }
  asMulti():  MultiField   { return this.field as MultiField; }
  asTable():  TableField   { return this.field as TableField; }
  asRaw():    RawField     { return this.field as RawField; }

  singleValue(): string {
    return resolveSingle(this.data, this.asSingle());
  }

  multiItems(): string[] {
    const f = this.asMulti();
    const src = resolvePath(this.data, f.source);
    if (!Array.isArray(src)) return [];
    if (f.valueField) {
      return src.map(item => item?.[f.valueField!]).filter(v => v != null).map(String);
    }
    return src.map(v => String(v));
  }

  tableRows(): any[] {
    return resolveSource(this.data, this.asTable());
  }

  cellValue(row: any, colKey: string): string {
    return resolveRowValue(row, colKey);
  }

  hasSingleDetail(): boolean {
    const s = this.asSingle();
    return !!s.details && !!s.detailSource && resolvePath(this.data, s.detailSource) != null;
  }

  openSingleDetail(): void {
    const s = this.asSingle();
    if (!s.details || !s.detailSource) return;
    const row = resolvePath(this.data, s.detailSource);
    if (row == null) return;
    this.openDetailModal(row, s.details, s.label);
  }

  rawJson(): string {
    const v = resolvePath(this.data, this.asRaw().source);
    if (v == null) return '—';
    try { return JSON.stringify(this.stripNulls(v), null, 2); }
    catch { return String(v); }
  }

  private stripNulls(value: any): any {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      const arr = value.map(i => this.stripNulls(i)).filter(i => i !== undefined);
      return arr.length ? arr : undefined;
    }
    if (typeof value === 'object') {
      const obj: any = {};
      for (const [k, v] of Object.entries(value)) {
        const s = this.stripNulls(v);
        if (s !== undefined) obj[k] = s;
      }
      return Object.keys(obj).length ? obj : undefined;
    }
    return value;
  }

  toggleRaw(): void { this.rawOpen = !this.rawOpen; }

  // ── Drilldown ─────────────────────────────────────────────────────────────

  openDetail(row: any, field: TableField): void {
    if (!field.details) return;
    this.openDetailModal(row, field.details);
  }

  private openDetailModal(row: any, det: FieldDetails, titleOverride?: string): void {
    const resolvedTitle = titleOverride ?? (det.titleField ? resolveRowValue(row, det.titleField) : 'Detail');
    const resolvedSubtitle = det.subtitleField ? resolveRowValue(row, det.subtitleField) : undefined;

    let groups: TemplateGroup[];
    if (det.mode === 'template' && det.ref && this.subTemplates?.[det.ref]) {
      groups = this.subTemplates[det.ref].groups;
    } else if (det.mode === 'inline' && det.groups) {
      groups = det.groups;
    } else if (det.mode === 'yaml') {
      const ref = this.modalService.open(ResourceDetailModalComponent,
        { windowClass: 'detail-modal-80', size: 'xl' });
      ref.componentInstance.title    = resolvedTitle;
      ref.componentInstance.subtitle = resolvedSubtitle;
      ref.componentInstance.row      = row;
      ref.componentInstance.groups   = [{ name: 'YAML', fields: [{ key: '_raw', label: 'YAML', type: 'raw', source: 'row', expanded: true }] }];
      ref.componentInstance.subTemplates = this.subTemplates;
      return;
    } else {
      return;
    }

    const ref = this.modalService.open(ResourceDetailModalComponent,
      { windowClass: 'detail-modal-80', size: 'xl' });
    ref.componentInstance.title    = resolvedTitle;
    ref.componentInstance.subtitle = resolvedSubtitle;
    ref.componentInstance.row      = row;
    ref.componentInstance.groups   = groups;
    ref.componentInstance.subTemplates = this.subTemplates;
  }
}
