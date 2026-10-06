import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { HideWhen, MenuActionEvent, ResourceViewTemplate, SingleField, SubTemplate, TemplateField, TemplateGroup } from './result-view-template.model';
import { resolvePath } from './path-resolver.util';

/**
 * Renders a declarative resource view template. One sub-tab per group (via ngbNav)
 * with fields rendered by <app-field-renderer>. Pure presentation — all data
 * access goes through `resolvePath` utilities.
 *
 * Fields of type `single` are grouped into a responsive tile grid at the top of
 * each sub-panel; other field types follow.
 */
@Component({
  selector: 'app-resource-template-view',
  templateUrl: './resource-template-view.component.html',
  styleUrls: ['./resource-template-view.component.scss'],
  standalone: false,
  // Angular 22 defaults to OnPush; these components assign plain fields from subscribe handlers.
  changeDetection: ChangeDetectionStrategy.Eager
})
export class ResourceTemplateViewComponent implements OnChanges {
  @Input() template?: ResourceViewTemplate | null;
  @Input() data: any;
  @Output() menuAction = new EventEmitter<MenuActionEvent>();

  activeGroup = '0';

  ngOnChanges(changes: SimpleChanges): void {
    // Reset selected group when the template swaps to a different resource.
    if (changes['template'] && !changes['template'].firstChange) {
      this.activeGroup = '0';
    }
  }

  trackByIndex(i: number): number { return i; }

  /** Visible groups — hides any group whose `hideWhen` predicate matches the data. */
  visibleGroups(): TemplateGroup[] {
    return (this.template?.groups ?? []).filter(g => !this.matchesHideWhen(g.hideWhen));
  }

  singleFields(group: TemplateGroup): TemplateField[] {
    return group.fields.filter(f => {
      if (f.type !== 'single' || (f as SingleField).fullWidth) return false;
      const sf = f as SingleField;
      if (this.matchesHideWhen(sf.hideWhen)) return false;
      if (sf.hideWhenEmpty) {
        const v = resolvePath(this.data, sf.value);
        return v != null && v !== '';
      }
      return true;
    });
  }

  fullWidthSingleFields(group: TemplateGroup): TemplateField[] {
    return group.fields.filter(f =>
      f.type === 'single' && (f as SingleField).fullWidth
        && !this.matchesHideWhen((f as SingleField).hideWhen));
  }

  otherFields(group: TemplateGroup): TemplateField[] {
    return group.fields.filter(f => f.type !== 'single' && !this.matchesHideWhen((f as any).hideWhen));
  }

  /** True when the data satisfies the predicate (i.e. the field/group should be hidden). */
  private matchesHideWhen(h?: HideWhen): boolean {
    if (!h) return false;
    const v = resolvePath(this.data, h.path);
    if ('equals' in h && h.equals !== undefined && v === h.equals) return true;
    if ('notEquals' in h && h.notEquals !== undefined && v !== h.notEquals) return true;
    return false;
  }
}
