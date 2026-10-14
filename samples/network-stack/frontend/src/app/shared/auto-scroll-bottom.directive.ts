import { AfterViewChecked, Directive, ElementRef, inject } from '@angular/core';

/**
 * Keeps a log console (<pre class="console">) pinned to its newest line as content streams in —
 * WITHOUT fighting the user: it scrolls only when the content actually grew AND the user was already
 * near the bottom before the growth (scrolled-up readers stay where they are). Tracking the last
 * scrollHeight also skips the forced synchronous layout on the change-detection passes where nothing
 * changed (the parent view polls every 3s).
 */
@Directive({ selector: '[autoScrollBottom]' })
export class AutoScrollBottomDirective implements AfterViewChecked {
  private static readonly BOTTOM_THRESHOLD_PX = 40;

  private readonly el = inject(ElementRef<HTMLElement>);
  private lastScrollHeight = 0;

  ngAfterViewChecked(): void {
    const node = this.el.nativeElement;
    const grown = node.scrollHeight > this.lastScrollHeight;
    if (!grown) {
      return;
    }
    // "Near the bottom" is judged against the PREVIOUS height — i.e. where the user was before the
    // new content landed.
    const wasNearBottom =
      node.scrollTop + node.clientHeight >= this.lastScrollHeight - AutoScrollBottomDirective.BOTTOM_THRESHOLD_PX;
    if (this.lastScrollHeight === 0 || wasNearBottom) {
      node.scrollTop = node.scrollHeight;
    }
    this.lastScrollHeight = node.scrollHeight;
  }
}
