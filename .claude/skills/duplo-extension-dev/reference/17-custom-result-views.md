# Custom result views — the hand-written Result content of a detail page

**Every Result panel is written for its resource.** There is no declarative renderer in the dev-kit
([09-result-templates](09-result-templates.md)); the Result view is real markup describing what *this*
resource produced — tiles for its headline facts, tables for its collections, tabs when there is more
than one kind of thing to show (live state, logs, actions, charts, an Ask AI session). The shell those
tabs sit in — header, Spec | Result switcher, main card, lifecycle rail — is
[19-detail-page](19-detail-page.md); this doc is what goes **inside** the main card's Result view. The
worked example is [`samples/network-stack`](../../../../samples/network-stack) (tabs: **Overview |
Network | Logs | Ask AI**).

**Deciding the tabs (per resource, from the settled Result fields):** one `Overview` tab of tile
sections is the floor — even a one-field result gets it (`samples/helloworld`). Add a tab per distinct
concern: a collection worth its own table (Network, Children), a stream (Logs), an opt-in Ask AI
session (always last). Name the intended tabs in the shape you present for approval.

## Structure

The tab strip lives **inside the main card's Result view** — `scrollable-nav-tab` wrapping one
`ngbNav` styled by `.g-tabs`, Overview first, one standalone panel component per tab:

```html
@else {   <!-- view() === 'result' -->
  <scrollable-nav-tab>
    <ul ngbNav #resultNav="ngbNav" class="nav nav-tabs flat-tabs g-tabs" [(activeId)]="activeTab">
      <li [ngbNavItem]="'overview'">
        <a ngbNavLink>Overview</a>
        <ng-template ngbNavContent>
          <ns-overview-panel [item]="it" />          <!-- .g-sec sections of .g-tiles -->
        </ng-template>
      </li>
      <li [ngbNavItem]="'network'">
        <a ngbNavLink>Network <span class="tab-count">{{ it.result?.subnetIds?.length || 0 }}</span></a>
        <ng-template ngbNavContent><ns-network-panel [item]="it" /></ng-template>
      </li>
      <li [ngbNavItem]="'logs'">
        <a ngbNavLink>Logs</a>
        <ng-template ngbNavContent><ns-logs-panel [item]="it" /></ng-template>
      </li>
      <!-- Ask AI (OPT-IN, when the user requested it) is ALWAYS the LAST tab — see 16-ask-ai -->
      <li [ngbNavItem]="'ask-ai'">
        <a ngbNavLink>Ask AI</a>
        <ng-template ngbNavContent><ns-ask-ai-panel [resource]="it" /></ng-template>
      </li>
    </ul>
  </scrollable-nav-tab>
  <div [ngbNavOutlet]="resultNav" class="mt-50"></div>
}
```

- **Overview leads with what the user must act on**, then faults, then `.g-sec` sections of
  `.g-tiles.c3` (see 19 for the tile grammar). Panel components that render tiles import the same
  `detail-page.scss` via `styleUrl` (styles are view-encapsulated — `samples/network-stack`'s
  `overview-panel.component.ts` does this).
- **Actions never sit above the strip.** Resource-wide actions (Plan / Apply, refresh) are `g-btn-ghost`
  buttons in the page header's `.g-actions` ([19-detail-page](19-detail-page.md)); actions on one tab's
  data go inside that panel, in a `.g-sec-h .g-sec-actions` row. No heading, no bar, no footer around
  the tab strip — the `<scrollable-nav-tab>` is the first element of the Result view.
- `ngbNav` and `scrollable-nav-tab` come with `CommonLibComponentsModule` — no extra dependency.
- **Each tab body is its own standalone component** under `shared/` — self-contained fetch + state, reusable
  across resources. Small render-only sections can stay inline; anything with its own data belongs in a
  panel component.
- **Conditional tabs** are just `@if` around the `<li>` (e.g. a tab that only exists when the spec section
  is present or the result has data).

## Lazy loading — free, and it's the "tab opened" hook

`<ng-template ngbNavContent>` is not instantiated until the tab is first shown, so a panel component's
`ngOnInit` fires on first open — that IS the lazy-load hook. Panels fetch their own data there (usually a
**custom controller endpoint** per tab — see [05-custom-actions](05-custom-actions.md) §6). Only data that
lives on the parent needs an explicit `(activeIdChange)` handler.

> Each of those per-tab endpoints needs an access decision. A plain read of the resource's own data is
> covered by the inherited GET verb check and needs nothing; a tab that triggers work or reveals
> credentials/logs a plain "can edit" grant shouldn't imply takes a named action
> ([18-access-control](18-access-control.md)). `samples/network-stack` shows both on one controller.

## State: `[(activeId)]` wants a plain field, not a signal

ngbNav writes `activeId` from a template event, and a plain field repaints fine under OnPush — don't fight
it with a signal (precedent + comment: `samples/parent-child/frontend/src/app/parents/view-parent.component.ts`).
One field per nav:

```ts
protected activeTab = 'overview';   // plain field — ngbNav two-way binds it
```

Tab state is not URL-persisted by default; a reload lands on the first tab. Add a query param yourself if
deep-linking matters.

## Polling: start on non-terminal status, stop on terminal, unsubscribe on destroy

```ts
// Match the sample (and your platform's terminal/paused statuses) — polling must also stop on
// DeprovisionFailed / Blocked / WaitingForApproval or it loops forever against a stuck resource.
private static readonly TERMINAL = ['Complete', 'Failed', 'DeProvisioned', 'DeprovisionFailed', 'Blocked', 'WaitingForApproval'];
private readonly destroyRef = inject(DestroyRef);
private poll?: Subscription;

ngOnInit(): void {
  this.refresh();
  this.destroyRef.onDestroy(() => this.poll?.unsubscribe());
}

private refresh(): void {
  this.svc.get(this.id).subscribe(i => {
    this.item.set(i);
    const inFlight = !ViewComponent.TERMINAL.includes(i?.status);
    if (inFlight && !this.poll) this.poll = interval(3000).subscribe(() => this.refresh());
    if (!inFlight && this.poll) { this.poll.unsubscribe(); this.poll = undefined; }
  });
}
```

A panel whose data keeps changing after the resource is terminal (e.g. live infra state) polls **itself** —
the parent's poll has stopped by then.

## Never a dead empty state

Until the result lands, render the **planned values from the spec** (labelled as planned/creating), not an
empty panel. Pair the sections on presence of the result field:

```html
@if (!it.result?.vpcId) { <!-- planned values from it.spec + a "Creating…" status line --> }
@if (it.result?.vpcId) { <!-- real values --> }
```

## Change-detection traps (all real, all painful)

- **`track` is load-bearing** in `@for` over arrays rebuilt by polling — without it every poll tick rebuilds
  the DOM nodes and clicks land on detached elements.
- **Memoize derived arrays** (or compute them in the fetch handler): a getter returning a fresh array every
  CD cycle churns child `input()`s every tick.
- Prefer **input setters / computed()** over method calls in templates for anything non-trivial.

## You own the markup

- Follow the [use-ng22] rules (standalone, signals, `@if/@for`, OnPush) — panels are YOUR code and must
  pass the ng22 verification gate.
- Buttons and menus are wired directly in your view/panels ([05-custom-actions](05-custom-actions.md) §4);
  there is no declarative menu wiring to lean on.
- **`[innerHTML]` + CSS:** a component that injects rich HTML via `[innerHTML]` gets no scoped styles on
  that markup (emulated `ViewEncapsulation` only tags what the template renders). Set
  `encapsulation: ViewEncapsulation.None` on that component (namespace your selectors), or style the
  injected markup with the globally-loaded theme — the remote ships no global CSS of its own.

## Ask AI (opt-in) composes here

When the user explicitly requested Ask AI sessions ([16-ask-ai](16-ask-ai.md)), the Ask AI panel is the
**LAST tab of this strip** — never an entry in the header's Spec | Result switcher. Every view already has
the strip (Overview at minimum), so opting in is appending one `<li>` after the last existing tab.
