import { AudioStreamer } from '../audio/AudioStreamer';
import {
  VIBE_PALETTES,
  type AudioMetrics,
  type BrowserActionEvent,
  type ClientToServerMessage,
  type ServerToClientMessage,
  type SessionState,
  type ToolCallPayload,
  type ToolResponsePayload,
  type VibeTheme,
} from '../types/era';

export interface LiveSessionCallbacks {
  onStateChange: (state: SessionState) => void;
  onThemeChange: (theme: VibeTheme) => void;
  onActionExecuted: (action: BrowserActionEvent) => void;
  onError: (message: string) => void;
}

const KNOWN_SITE_SHORTCUTS: Record<string, string> = {
  youtube: 'https://www.youtube.com',
  spotify: 'https://open.spotify.com',
  github: 'https://github.com',
  google: 'https://www.google.com',
  gmail: 'https://mail.google.com',
  reddit: 'https://www.reddit.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  netflix: 'https://www.netflix.com',
  instagram: 'https://www.instagram.com',
  linkedin: 'https://www.linkedin.com',
  wikipedia: 'https://www.wikipedia.org',
  notion: 'https://www.notion.so',
  figma: 'https://www.figma.com',
  twitch: 'https://www.twitch.tv',
};

export class LiveSession {
  private ws: WebSocket | null = null;
  private audioStreamer: AudioStreamer | null = null;
  private state: SessionState = 'disconnected';
  private callbacks: LiveSessionCallbacks;
  private isDisconnecting = false;

  constructor(callbacks: LiveSessionCallbacks) {
    this.callbacks = callbacks;
  }

  public getState(): SessionState {
    return this.state;
  }

  public async connect(): Promise<void> {
    if (this.state !== 'disconnected') return;

    this.isDisconnecting = false;
    this.setState('connecting');

    const streamer = new AudioStreamer({
      onAudioData: (base64Pcm16) => {
        if (this.state === 'listening' || this.state === 'speaking') {
          this.send({ type: 'audio', data: base64Pcm16 });
        }
      },
      onPlaybackStateChange: (isPlaying) => {
        if (this.state === 'disconnected' || this.state === 'connecting') return;
        this.setState(isPlaying ? 'speaking' : 'listening');
      },
      onError: (err) => {
        this.callbacks.onError(err.message);
        this.disconnect();
      },
    });

    this.audioStreamer = streamer;

    try {
      await streamer.start();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not initialize microphone audio.';
      this.callbacks.onError(message);
      this.cleanup();
      this.setState('disconnected');
      return;
    }

    if (this.isDisconnecting) {
      this.cleanup();
      this.setState('disconnected');
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/live`;

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      // Wait for server 'ready' event confirming Gemini Live connection is active
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      let msg: ServerToClientMessage;
      try {
        msg = JSON.parse(event.data) as ServerToClientMessage;
      } catch {
        return;
      }

      switch (msg.type) {
        case 'ready':
          if (this.state === 'connecting') {
            this.setState('listening');
          }
          break;
        case 'audio':
          this.audioStreamer?.playPcm24kChunk(msg.data);
          break;
        case 'interrupted':
          this.audioStreamer?.interrupt();
          if (this.state === 'speaking') {
            this.setState('listening');
          }
          break;
        case 'turn_complete':
          // Playback state transition is handled accurately by AudioStreamer's onended queue
          break;
        case 'scheduledTaskUpdated':
        case 'scheduledTaskWarning':
        case 'scheduledTaskTriggered':
          try {
            window.dispatchEvent(new CustomEvent('era:scheduledTask', { detail: msg }));
          } catch {}
          break;
        case 'openWebsite':
          if ((msg as any).url) {
            this.launchExternalUrl((msg as any).url);
          }
          break;
        case 'tool_call':
          this.handleToolCalls(msg.calls);
          break;
        case 'error':
          this.callbacks.onError(msg.message);
          this.disconnect();
          break;
      }
    };

    ws.onerror = () => {
      if (!this.isDisconnecting) {
        this.callbacks.onError('Voice connection dropped. Tap the orb to reconnect.');
      }
      this.cleanup();
      this.setState('disconnected');
    };

    ws.onclose = () => {
      if (!this.isDisconnecting && this.state !== 'disconnected') {
        this.cleanup();
        this.setState('disconnected');
      }
    };
  }

  public disconnect(): void {
    this.isDisconnecting = true;
    this.cleanup();
    this.setState('disconnected');
  }

  public setMuted(muted: boolean): void {
    this.audioStreamer?.setMuted(muted);
    if (muted) {
      this.send({ type: 'audio_stream_end' });
    }
  }

  public isMuted(): boolean {
    return this.audioStreamer?.isMuted() ?? false;
  }

  public interruptPlayback(): void {
    this.audioStreamer?.interrupt();
    if (this.state === 'speaking') {
      this.setState('listening');
    }
  }

  public getAudioMetrics(): AudioMetrics | null {
    return this.audioStreamer?.getMetrics() ?? null;
  }

  private handleToolCalls(calls: ToolCallPayload[]): void {
    const responses: ToolResponsePayload[] = calls.map((call) => ({
      id: call.id,
      name: call.name,
      response: this.executeBrowserTool(call),
    }));

    // Send toolResponse back instantly
    this.send({
      type: 'tool_response',
      responses,
    });
  }

  private executeBrowserTool(call: ToolCallPayload): Record<string, unknown> {
    const args = call.args ?? {};

    switch (call.name) {
      case 'openWebsite': {
        const rawUrl = String(args.url ?? '').trim();
        const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : undefined;
        const normalizedUrl = this.normalizeUrl(rawUrl);
        if (!normalizedUrl) {
          return { success: false, error: 'Invalid or empty URL provided.' };
        }

        const launched = this.launchExternalUrl(normalizedUrl);
        const displayHost = this.extractHost(normalizedUrl);

        this.callbacks.onActionExecuted({
          id: call.id,
          toolName: 'openWebsite',
          title: label ? `Opening ${label}` : `Opening ${displayHost}`,
          detail: launched
            ? `Launched ${displayHost} in a new tab`
            : `Tap below to open ${displayHost}`,
          url: normalizedUrl,
          timestamp: Date.now(),
        });

        return {
          success: true,
          url: normalizedUrl,
          opened: launched,
          note: launched
            ? `Opened ${normalizedUrl} for the user.`
            : `Prepared ${normalizedUrl} for the user with a one-tap launch card.`,
        };
      }

      case 'searchWeb': {
        const query = String(args.query ?? '').trim();
        if (!query) {
          return { success: false, error: 'Search query was empty.' };
        }
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        const launched = this.launchExternalUrl(searchUrl);

        this.callbacks.onActionExecuted({
          id: call.id,
          toolName: 'searchWeb',
          title: `Searching "${query}"`,
          detail: launched ? 'Opened Google search results' : 'Tap below to view results',
          url: searchUrl,
          timestamp: Date.now(),
        });

        return {
          success: true,
          query,
          url: searchUrl,
          opened: launched,
        };
      }

      case 'setVibeTheme': {
        const requested = String(args.theme ?? 'crimson').toLowerCase().trim() as VibeTheme;
        const validTheme: VibeTheme = requested in VIBE_PALETTES ? requested : 'crimson';
        this.callbacks.onThemeChange(validTheme);

        this.callbacks.onActionExecuted({
          id: call.id,
          toolName: 'setVibeTheme',
          title: `Aura shifted to ${VIBE_PALETTES[validTheme].label}`,
          detail: 'Ambient palette updated',
          timestamp: Date.now(),
        });

        return {
          success: true,
          activeTheme: validTheme,
          label: VIBE_PALETTES[validTheme].label,
        };
      }

      case 'getCurrentTime': {
        const now = new Date();
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const formattedTime = new Intl.DateTimeFormat('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(now);
        const formattedDate = new Intl.DateTimeFormat('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        }).format(now);

        return {
          time: formattedTime,
          date: formattedDate,
          timeZone,
          iso: now.toISOString(),
        };
      }

      case 'copyToClipboard': {
        const text = String(args.text ?? '');
        const label =
          typeof args.label === 'string' && args.label.trim()
            ? args.label.trim()
            : 'Copied to clipboard';
        if (!text) {
          return { success: false, error: 'Nothing to copy.' };
        }

        if (navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(text).catch(() => {});
        }

        this.callbacks.onActionExecuted({
          id: call.id,
          toolName: 'copyToClipboard',
          title: label,
          detail: text.length > 52 ? `${text.slice(0, 52)}...` : text,
          timestamp: Date.now(),
        });

        return {
          success: true,
          copiedLength: text.length,
        };
      }

      default:
        return {
          success: false,
          error: `Unknown tool: ${call.name}`,
        };
    }
  }

  private normalizeUrl(raw: string): string | null {
    if (!raw) return null;
    const lowered = raw.toLowerCase().replace(/^www\./, '');
    if (KNOWN_SITE_SHORTCUTS[lowered]) {
      return KNOWN_SITE_SHORTCUTS[lowered];
    }

    let candidate = raw;
    if (!/^https?:\/\//i.test(candidate)) {
      if (!candidate.includes('.')) {
        candidate = `${candidate}.com`;
      }
      candidate = `https://${candidate}`;
    }

    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      return parsed.toString();
    } catch {
      return null;
    }
  }

  private extractHost(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  private launchExternalUrl(url: string): boolean {
    try {
      if ((window as any).eraDesktop?.openExternal) {
        (window as any).eraDesktop.openExternal(url);
        return true;
      }
      fetch('/api/system/open-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      }).catch(() => {});
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      return true;
    } catch {
      return false;
    }
  }

  private send(message: ClientToServerMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private cleanup(): void {
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          this.ws.close(1000, 'Client disconnected');
        }
      } catch {
        // Ignore
      }
      this.ws = null;
    }

    if (this.audioStreamer) {
      this.audioStreamer.dispose();
      this.audioStreamer = null;
    }
  }

  private setState(next: SessionState): void {
    if (this.state !== next) {
      this.state = next;
      this.callbacks.onStateChange(next);
    }
  }
}
