import { Component, computed, input } from '@angular/core';

// Self-contained status pill for extension list/detail views.
//
// The platform's <status-with-style> is NOT exported by the lib's CommonLibComponentsModule, so an extension
// that uses it renders a blank unknown element. This badge reproduces the same look (Vuexy pill, coloured by
// status) with no lib dependency. Import it into whichever component renders <app-status-badge [status]="…">.
@Component({
  selector: 'app-status-badge',
  template: `<span class="badge badge-pill badge-{{ style() }} text-capitalize">{{ status() || '—' }}</span>`,
})
export class StatusBadgeComponent {
  readonly status = input<string>();

  // computed(), not a getter: recomputes only when `status` actually changes rather than on every
  // change-detection pass, and keeps the component correct under the default OnPush strategy.
  protected readonly style = computed(() => {
    const s = (this.status() || '').toLowerCase();
    if (['complete', 'completed', 'ready', 'active', 'available', 'running', 'succeeded', 'ok'].includes(s)) {
      return 'success';
    }
    if (['failed', 'error', 'rejected'].includes(s)) {
      return 'danger';
    }
    if (s === 'blocked') {
      return 'warning';
    }
    if (s) {
      return 'info'; // new, ticketcreated, processing, updating, etc.
    }
    return 'secondary';
  });
}
