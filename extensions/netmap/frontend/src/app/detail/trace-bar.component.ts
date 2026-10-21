import { Component, computed, input, model, output, signal } from '@angular/core';
import { GraphIndex } from '../model/graph-index';
import { PathTarget, Protocol } from '../model/path';
import { SearchHit, search } from '../model/search';

export interface TraceRequest {
  from: string;
  direction: 'outbound' | 'inbound';
  to?: PathTarget;
  protocol: Protocol;
  port: number;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Search box above the map, plus the trace controls once a resource is picked. */
@Component({
  selector: 'nm-trace-bar',
  styles: [`
    :host { display: block; margin-bottom: 8px; }
    .tb { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .box { position: relative; flex: 1 1 280px; min-width: 220px; max-width: 460px; }
    .box.dest { flex: 1 1 220px; max-width: 320px; }
    .box input { width: 100%; }
    .menu { position: absolute; z-index: 20; top: calc(100% + 2px); left: 0; right: 0; max-height: 320px; overflow: auto; background: #fff; border: 1px solid #dcdfe6; border-radius: 8px; box-shadow: 0 6px 18px rgba(0,0,0,.12); padding: 4px 0; }
    .menu button { display: block; width: 100%; text-align: left; border: 0; background: none; padding: 5px 10px; cursor: pointer; }
    .menu button:hover, .menu button.active { background: #eef6f7; }
    .menu .l { font-weight: 600; font-size: .82rem; }
    .menu .s { font-size: .72rem; color: #8a8797; }
    .menu .w { font-size: .7rem; color: #0d8f9e; float: right; margin-left: 8px; }
    .menu .none { padding: 6px 10px; font-size: .8rem; color: #8a8797; }
    .from { display: inline-flex; align-items: center; gap: 6px; font-size: .8rem; background: #eef6f7; border-radius: 1rem; padding: 3px 4px 3px 10px; max-width: 320px; }
    .from span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .from button { border: 0; background: none; color: #8a8797; cursor: pointer; }
    .ctl { display: inline-flex; gap: 6px; align-items: center; font-size: .8rem; color: #6e6b7b; }
    .ctl select { width: auto; }
    .ctl input { width: 80px; }
  `],
  template: `
    <div class="tb">
      <div class="box">
        <input class="form-control form-control-sm" type="search" placeholder="Find a resource — name, id, IP, CIDR or DNS name"
               [value]="text()" (input)="text.set(val($event)); open.set(true)" (focus)="open.set(true)" (blur)="closeSoon(open)"
               (keydown)="keys($event, hits(), pick.bind(this), open)" aria-label="Search resources" />
        @if (open() && text().trim()) {
          <div class="menu" role="listbox">
            @for (h of hits(); track h.nodeId; let i = $index) {
              <button type="button" [class.active]="i === cursor()" (mousedown)="$event.preventDefault()" (click)="pick(h)">
                <span class="w">{{ h.why }}</span><div class="l">{{ h.label }}</div><div class="s">{{ h.sub }}</div>
              </button>
            } @empty { <div class="none">Nothing matches.</div> }
          </div>
        }
      </div>

      @if (sourceLabel(); as s) {
        <span class="from" [title]="s"><span>From <b>{{ s }}</b></span><button type="button" title="Clear" aria-label="Clear the source" (click)="source.set(null)">✕</button></span>
        <div class="box dest">
          <input class="form-control form-control-sm" type="search" placeholder="To: internet (default), an IP or a resource"
                 [value]="destText()" (input)="setDest(val($event))" (focus)="destOpen.set(true)" (blur)="closeSoon(destOpen)"
                 (keydown)="keys($event, destHits(), pickDest.bind(this), destOpen)" aria-label="Destination" />
          @if (destOpen() && destText().trim() && !destIsIp()) {
            <div class="menu" role="listbox">
              @for (h of destHits(); track h.nodeId; let i = $index) {
                <button type="button" [class.active]="i === cursor()" (mousedown)="$event.preventDefault()" (click)="pickDest(h)">
                  <span class="w">{{ h.why }}</span><div class="l">{{ h.label }}</div><div class="s">{{ h.sub }}</div>
                </button>
              } @empty { <div class="none">Nothing matches — enter an IPv4 address or pick a resource.</div> }
            </div>
          }
        </div>
        <label class="ctl">Protocol
          <select class="custom-select custom-select-sm form-control-sm" [value]="protocol()" (change)="protocol.set($any(val($event)))">
            <option value="tcp">TCP</option><option value="udp">UDP</option><option value="icmp">ICMP</option><option value="all">All</option>
          </select>
        </label>
        @if (protocol() === 'tcp' || protocol() === 'udp') {
          <label class="ctl">Port <input class="form-control form-control-sm" type="number" min="0" max="65535" [value]="port()" (input)="port.set(+val($event))" /></label>
        }
        <button type="button" class="btn btn-sm btn-primary" [disabled]="!destValid()" (click)="run('outbound')">{{ destText().trim() ? 'Trace path →' : 'Trace to internet →' }}</button>
        <button type="button" class="btn btn-sm btn-outline-primary" (click)="run('inbound')" title="Who can reach this resource">← Trace inbound</button>
      }
    </div>
  `,
})
export class TraceBarComponent {
  readonly index = input<GraphIndex | null>(null);
  /** The picked resource (also set from outside, e.g. the node panel's "Trace path"). */
  readonly source = model<string | null>(null);
  readonly picked = output<string>();
  readonly trace = output<TraceRequest>();

  protected readonly text = signal('');
  protected readonly open = signal(false);
  protected readonly cursor = signal(0);
  protected readonly destText = signal('');
  protected readonly destOpen = signal(false);
  protected readonly destId = signal<string | null>(null);
  protected readonly protocol = signal<Protocol>('tcp');
  protected readonly port = signal(443);

  protected readonly hits = computed(() => (this.index() ? search(this.index()!, this.text(), 12) : []));
  protected readonly destHits = computed(() => (this.index() && !this.destId() ? search(this.index()!, this.destText(), 12) : []));
  protected readonly destIsIp = computed(() => IPV4.test(this.destText().trim()));
  protected readonly destValid = computed(() => !this.destText().trim() || this.destIsIp() || !!this.destId());
  protected readonly sourceLabel = computed(() => {
    const id = this.source();
    const n = id ? this.index()?.node(id) : undefined;
    return n ? n.name || n.nativeId : '';
  });

  /** Back to an empty search (used by the page's Clear button). */
  reset(): void {
    this.text.set('');
    this.open.set(false);
    this.cursor.set(0);
    this.destText.set('');
    this.destOpen.set(false);
    this.destId.set(null);
    this.protocol.set('tcp');
    this.port.set(443);
    this.source.set(null);
  }

  protected val(ev: Event): string {
    return (ev.target as HTMLInputElement).value;
  }

  protected closeSoon(flag: { set(v: boolean): void }): void {
    setTimeout(() => flag.set(false), 120);
  }

  protected keys(ev: KeyboardEvent, hits: SearchHit[], choose: (h: SearchHit) => void, flag: { set(v: boolean): void }): void {
    if (ev.key === 'ArrowDown') { this.cursor.set(Math.min(hits.length - 1, this.cursor() + 1)); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp') { this.cursor.set(Math.max(0, this.cursor() - 1)); ev.preventDefault(); }
    else if (ev.key === 'Enter' && hits[this.cursor()]) { choose(hits[this.cursor()]); ev.preventDefault(); }
    else if (ev.key === 'Escape') flag.set(false);
  }

  protected pick(h: SearchHit): void {
    this.open.set(false);
    this.cursor.set(0);
    this.text.set(h.label);
    this.source.set(h.nodeId);
    this.picked.emit(h.nodeId);
  }

  protected setDest(v: string): void {
    this.destText.set(v);
    this.destId.set(null);
    this.destOpen.set(true);
    this.cursor.set(0);
  }

  protected pickDest(h: SearchHit): void {
    this.destOpen.set(false);
    this.cursor.set(0);
    this.destText.set(h.label);
    this.destId.set(h.nodeId);
  }

  protected run(direction: 'outbound' | 'inbound'): void {
    const from = this.source();
    if (!from) return;
    const d = this.destText().trim();
    const to: PathTarget = !d ? { kind: 'internet' } : this.destId() ? { kind: 'node', id: this.destId()! } : { kind: 'ip', ip: d };
    const port = Number.isFinite(this.port()) && this.port() >= 0 && this.port() <= 65535 ? this.port() : 443;
    this.trace.emit({ from, direction, to: direction === 'outbound' ? to : undefined, protocol: this.protocol(), port });
  }
}
