import { Component, inject } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { ICON_SPRITE } from '../model/icons';

// Injects the DuploCloud icon <symbol>s once; <use href="#nm-ic-…"> elsewhere references them. The sprite is a
// static, in-repo constant, so bypassing the sanitizer is safe (the sanitizer would strip <svg>/<symbol>).
@Component({
  selector: 'nm-icon-sprite',
  template: `<div aria-hidden="true" [innerHTML]="sprite"></div>`,
})
export class IconSpriteComponent {
  protected readonly sprite = inject(DomSanitizer).bypassSecurityTrustHtml(ICON_SPRITE);
}
