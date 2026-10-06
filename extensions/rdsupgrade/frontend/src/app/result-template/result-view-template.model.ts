// Declarative view-template model — the shape of resources-frontend-templates/<Type>/<subType>.view-template.json
// served by the backend (IResourceViewTemplateService) and consumed by <app-resource-template-view>.
//
// VENDORED: this is a verbatim copy of the host's interfaces. It lives here only because the published
// @duplocloud-internal/ng-common-lib does not yet export the result renderer. Once the lib exports
// ResourceTemplateViewModule (Part 3a), delete this whole result-template/ folder and import the module
// + these types from the lib instead.

export interface ResourceViewTemplate {
  resourceType: string;
  subType: string;
  label: string;
  icon?: string;
  idField: string;
  groups: TemplateGroup[];
  subTemplates?: Record<string, SubTemplate>;
}

export interface SubTemplate {
  groups: TemplateGroup[];
}

/**
 * Conditional-visibility predicate. When attached to a group or field, the renderer evaluates `path`
 * against the data and hides the element when the resolved value satisfies `equals` / `notEquals`.
 */
export interface HideWhen {
  path: string;
  equals?: any;
  notEquals?: any;
}

export interface TemplateGroup {
  name: string;
  fields: TemplateField[];
  hideWhen?: HideWhen;
}

export type TemplateField = SingleField | MultiField | TableField | RawField;

export interface SingleField {
  key: string;
  label: string;
  type: 'single';
  value: string;                    // dot-path into data
  isTemplate?: boolean;             // '{...}' interpolation in value
  suffix?: string;
  mono?: boolean;                   // default true; false = normal font
  fullWidth?: boolean;              // span full width instead of grid tile (use for long values)
  hideWhenEmpty?: boolean;          // omit tile entirely when the value resolves to null/''
  hideWhen?: HideWhen;              // omit when an arbitrary path matches a value
  detailSource?: string;            // dot-path to the row object passed to the detail modal
  details?: FieldDetails;           // same drilldown config as TableField — tile becomes clickable
  cardMenus?: MenuAction[];         // top-right kebab on the tile
}

export interface MultiField {
  key: string;
  label: string;
  type: 'multi';
  source: string;                   // dot-path to array
  valueField?: string;              // field to extract when array-of-objects
  hideWhen?: HideWhen;
  cardMenus?: MenuAction[];         // top-right kebab on the multi block
}

export interface TableField {
  key: string;
  label: string;
  type: 'table';
  source: string;
  sourceType?: 'map' | 'wrap';       // map: {k:v}→[{__key,__value}]; wrap: object→[object]
  filter?: { field: string; value: string | number | boolean };
  columns: TemplateColumn[];
  details?: FieldDetails;
  hideWhen?: HideWhen;
  rowMenus?: MenuAction[];           // first-column ⋮ per row
  cardMenus?: MenuAction[];          // top-right ⋮ on the table block
}

export interface FieldDetails {
  mode: 'template' | 'yaml' | 'inline';
  ref?: string;             // sub-template key in ResourceViewTemplate.subTemplates
  groups?: TemplateGroup[]; // inline group definition (mode: 'inline')
  titleField?: string;      // dot-path in row → modal title
  subtitleField?: string;   // dot-path in row → modal subtitle
}

export interface TemplateColumn {
  key: string;                      // supports nested dot-paths
  label: string;
  isStatus?: boolean;               // render as colored status pill
}

/** One item in a kebab menu (row- or card-level). Defined in the template JSON. */
export interface MenuAction {
  id: string;          // emitted on click — e.g. "logs", "kubectl-exec"
  label: string;       // displayed in dropdown
  icon?: string;       // optional feather icon name
}

/** Emitted up the component chain when the user clicks any kebab menu item. */
export interface MenuActionEvent {
  menuId: string;            // MenuAction.id
  level: 'row' | 'card';     // where it came from
  fieldKey: string;          // TemplateField.key
  row?: any;                 // present only when level === 'row'
}

export interface RawField {
  key: string;
  label: string;
  type: 'raw';
  source: string;
  expanded?: boolean;
  hideWhen?: HideWhen;
  cardMenus?: MenuAction[];         // top-right kebab on the card
}
