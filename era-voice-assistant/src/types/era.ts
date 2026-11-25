export type SessionState = 'disconnected' | 'connecting' | 'listening' | 'speaking';

export type VibeTheme = 'crimson' | 'violet' | 'amber' | 'emerald' | 'obsidian';

export interface ThemePalette {
  id: VibeTheme;
  label: string;
  primary: string;
  secondary: string;
  glow: string;
  rgb: [number, number, number];
  secondaryRgb: [number, number, number];
}

export const VIBE_PALETTES: Record<VibeTheme, ThemePalette> = {
  crimson: {
    id: 'crimson',
    label: 'Velvet Crimson',
    primary: '#FB3B6B',
    secondary: '#FF758F',
    glow: 'rgba(251, 59, 107, 0.32)',
    rgb: [251, 59, 107],
    secondaryRgb: [255, 117, 143],
  },
  violet: {
    id: 'violet',
    label: 'Electric Violet',
    primary: '#9D4EDD',
    secondary: '#E0AAFF',
    glow: 'rgba(157, 78, 221, 0.32)',
    rgb: [157, 78, 221],
    secondaryRgb: [224, 170, 255],
  },
  amber: {
    id: 'amber',
    label: 'Golden Hour',
    primary: '#F59E0B',
    secondary: '#FDE68A',
    glow: 'rgba(245, 158, 11, 0.30)',
    rgb: [245, 158, 11],
    secondaryRgb: [253, 230, 138],
  },
  emerald: {
    id: 'emerald',
    label: 'Jade Pulse',
    primary: '#10B981',
    secondary: '#6EE7B7',
    glow: 'rgba(16, 185, 129, 0.30)',
    rgb: [16, 185, 129],
    secondaryRgb: [110, 231, 183],
  },
  obsidian: {
    id: 'obsidian',
    label: 'Silver Obsidian',
    primary: '#E2E8F0',
    secondary: '#94A3B8',
    glow: 'rgba(226, 232, 240, 0.24)',
    rgb: [226, 232, 240],
    secondaryRgb: [148, 163, 184],
  },
};

export interface BrowserActionEvent {
  id: string;
  toolName: string;
  title: string;
  detail: string;
  url?: string;
  timestamp: number;
}

export interface AudioMetrics {
  inputLevel: number;
  outputLevel: number;
  bins: Float32Array;
}

export interface ToolCallPayload {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResponsePayload {
  id: string;
  name: string;
  response: Record<string, unknown>;
}

export type ServerToClientMessage =
  | { type: 'ready' }
  | { type: 'audio'; data: string }
  | { type: 'interrupted' }
  | { type: 'turn_complete' }
  | { type: 'tool_call'; calls: ToolCallPayload[] }
  | { type: 'error'; message: string };

export type ClientToServerMessage =
  | { type: 'audio'; data: string }
  | { type: 'audio_stream_end' }
  | { type: 'tool_response'; responses: ToolResponsePayload[] };
