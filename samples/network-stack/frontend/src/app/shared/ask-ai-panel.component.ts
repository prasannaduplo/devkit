import { Component, OnInit, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonLibComponentsModule, extractErrorMessage } from '@duplocloud-internal/ng-common-lib';
import { AskAiTicket, NetworkStack, NetworkStackService } from '../network-stack.service';
import { StatusBadgeComponent } from './status-badge.component';

// Ask AI tab body (reference/16-ask-ai.md): the sessions list + the "start a session" dialog. This is
// the LAST tab of the Results tab strip — never an entry in the outer Spec/Result panel switcher. The
// typical use is post-provisioning: explore the created infra, debug issues. Sessions are ordinary chat
// tickets discriminated from the provisioning ticket by the dedicated `network-stack-askai` subType +
// originContext.metadata.purpose = "ask-ai"; the user can open as many as they want.
@Component({
  selector: 'ns-ask-ai-panel',
  imports: [CommonLibComponentsModule, FormsModule, StatusBadgeComponent],
  styles: [`
    .askai-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 1050; }
    .askai-dialog { position: fixed; top: 10%; left: 50%; transform: translateX(-50%); width: min(640px, 92vw);
      max-height: 80vh; overflow-y: auto; z-index: 1051; }
  `],
  template: `
    <div class="p-1">
      <div class="d-flex align-items-center">
        <h6 class="text-muted mb-0 mr-auto">AI Sessions</h6>
        <button class="btn btn-primary btn-sm" (click)="openDialog()">
          <i data-feather="message-circle" class="mr-50"></i> Ask AI
        </button>
      </div>

      @if (sessions().length) {
        <div class="list-group list-group-flush mt-50">
          @for (t of sessions(); track t.name) {
            <div class="list-group-item d-flex align-items-center px-0">
              <app-status-badge [status]="statusOf(t)"></app-status-badge>
              <a class="ml-75 mr-auto text-truncate" href="javascript:void(0)" (click)="openChat(t)">
                <span class="font-weight-bold">{{ t.name }}</span>
                @if (t.title) { <span class="text-muted ml-50">{{ t.title }}</span> }
              </a>
              @if (t.createdBy) { <small class="text-muted mr-1">{{ t.createdBy }}</small> }
              @if (statusOf(t) !== 'closed') {
                <button class="btn btn-outline-secondary btn-sm" (click)="close(t)">Close</button>
              }
            </div>
          }
        </div>
      } @else {
        <p class="text-muted font-small-3 mt-50 mb-50">No AI sessions yet — start one to explore or debug this stack.</p>
      }
    </div>

    @if (dialogOpen()) {
      <div class="askai-backdrop" (click)="dialogOpen.set(false)"></div>
      <div class="card askai-dialog p-2">
        <h4>Ask AI about {{ resource().name }}</h4>
        <p class="text-muted font-small-3">
          Starts a new AI chat session on this resource. The context below was prefilled from the resource —
          edit it as you like; the selected scopes' credentials are attached to the session.
        </p>

        <label class="form-label">Context</label>
        <textarea class="form-control" rows="6" [(ngModel)]="contextText" name="askAiContext"></textarea>

        <label class="form-label mt-75">Your question</label>
        <textarea class="form-control" rows="3" [(ngModel)]="questionText" name="askAiQuestion"
                  placeholder="What do you want to know or do?"></textarea>

        @if (scopes().length) {
          <label class="form-label mt-75">Scopes</label>
          @for (s of scopes(); track s.id) {
            <div class="custom-control custom-checkbox">
              <input type="checkbox" class="custom-control-input" [id]="'askai-scope-' + s.id"
                     [checked]="selectedScopeIds().has(s.id)" (change)="toggleScope(s.id)">
              <label class="custom-control-label" [for]="'askai-scope-' + s.id">{{ s.name }}</label>
            </div>
          }
        }

        @if (error(); as err) {
          <div class="alert alert-danger p-75 mt-1 mb-0">{{ err }}</div>
        }

        <div class="d-flex justify-content-end mt-1">
          <button class="btn btn-outline-secondary mr-75" (click)="dialogOpen.set(false)" [disabled]="busy()">Cancel</button>
          <button class="btn btn-primary" (click)="start()" [disabled]="busy() || !questionText.trim()">
            {{ busy() ? 'Starting…' : 'Start session' }}
          </button>
        </div>
      </div>
    }
  `,
})
export class AskAiPanelComponent implements OnInit {
  private readonly svc = inject(NetworkStackService);
  private readonly router = inject(Router);

  readonly resource = input.required<NetworkStack>();

  protected readonly sessions = signal<AskAiTicket[]>([]);
  protected readonly scopes = signal<{ id: string; name: string }[]>([]);
  protected readonly selectedScopeIds = signal<Set<string>>(new Set());
  protected readonly dialogOpen = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected contextText = '';
  protected questionText = '';

  ngOnInit(): void {
    this.reload();
  }

  private reload(): void {
    this.svc.listAskAiTickets(this.resource().id).subscribe(t => this.sessions.set(t));
  }

  openDialog(): void {
    const it = this.resource();
    this.contextText = this.svc.buildAskAiContext(it);
    this.error.set(null);
    this.svc.listScopes().subscribe(scopes => {
      this.scopes.set(scopes);
      // Pre-check the scopes the resource was provisioned with; the user can add/drop per session.
      const preset = new Set((it.spec?.scopeIds ?? []).filter(id => scopes.some(s => s.id === id)));
      this.selectedScopeIds.set(preset);
    });
    this.dialogOpen.set(true);
  }

  protected toggleScope(id: string): void {
    const next = new Set(this.selectedScopeIds());
    next.has(id) ? next.delete(id) : next.add(id);
    this.selectedScopeIds.set(next);
  }

  protected start(): void {
    const it = this.resource();
    this.busy.set(true);
    this.error.set(null);
    this.svc.resolveAgentId(it.id).subscribe({
      next: agentId => {
        if (!agentId) {
          this.busy.set(false);
          this.error.set('No AI agent is available in this workspace.');
          return;
        }
        this.svc.createAskAiTicket(it, agentId, [...this.selectedScopeIds()]).subscribe({
          next: name => {
            this.busy.set(false);
            if (!name) {
              this.error.set('Ticket was created but no name came back.');
              return;
            }
            this.dialogOpen.set(false);
            this.gotoChat(name, `${this.contextText}\n\nUser Question:\n${this.questionText.trim()}`);
          },
          // Surface the API's real message (reference/15) — never a bare alert().
          error: e => { this.busy.set(false); this.error.set(extractErrorMessage(e) || 'Failed to start the session.'); },
        });
      },
      error: () => { this.busy.set(false); this.error.set('Could not resolve an AI agent.'); },
    });
  }

  protected openChat(t: AskAiTicket): void {
    this.gotoChat(t.name);
  }

  protected close(t: AskAiTicket): void {
    this.svc.closeAskAiTicket(t.name).subscribe({ next: () => this.reload(), error: () => this.reload() });
  }

  /** list items carry no currentStatus — derive from the LAST history entry, default 'open'. */
  protected statusOf(t: AskAiTicket): string {
    const st = t.history?.statuses;
    return st?.length ? (st[st.length - 1]?.status || 'open') : 'open';
  }

  private gotoChat(name: string, seedMessage?: string): void {
    if (seedMessage) {
      // Platform contract: the chat view reads this key on init and auto-sends it into the empty ticket.
      // Set it immediately before navigating; use it for nothing else.
      sessionStorage.setItem('ai-redirect-new-query-message', seedMessage);
    }
    const url = `/ai/service-desk/${this.svc.workspaceId()}/tickets/chat/${name}`;
    this.router.navigateByUrl(url).then(ok => { if (!ok) window.location.assign(url); })
      .catch(() => window.location.assign(url));
  }
}
