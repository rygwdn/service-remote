export interface AudioSource {
  name: string;
  volume: number;
  muted: boolean;
  live: boolean; // true if source appears as an enabled item in the current program scene
  level: number; // Linear peak level 0.0–1.0 from InputVolumeMeters
}

export interface Channel {
  index: number;
  type: 'ch' | 'bus' | 'main' | 'mtx';
  label: string;
  fader: number;
  muted: boolean;
  level: number; // Linear peak level 0.0–1.0 (updated when a WS client is connected)
  source: number; // Physical input source (0 = unpatched); only meaningful for 'ch'
  linkedToNext: boolean; // True if this channel is linked with the next (odd/even pair)
}

export interface ServiceItem {
  id: string;
  title: string;
  kind: string;
  slideCount: number;
  index: number; // 1-based position in the full (unfiltered) Proclaim service item list
  sectionIndex: number; // 1-based position within the item's section (for GoToServiceItem)
  sectionCommand: string; // App Command to activate the item's section (e.g. 'StartService')
  section: string; // e.g. 'Pre-Service', 'Warmup', 'Service', 'Post-Service'
  group: string | null; // name of the containing Grouping item, or null
}

export interface ObsState {
  connected: boolean;
  currentScene: string;
  scenes: string[];
  streaming: boolean;
  recording: boolean;
  audioSources: AudioSource[];
}

export interface X32State {
  connected: boolean;
  channels: Channel[];
}

export interface ProclaimState {
  connected: boolean;
  onAir: boolean;
  currentItemId: string | null;
  currentItemTitle: string | null;
  currentItemType: string | null;
  slideIndex: number | null;
  serviceItems: ServiceItem[];
}

export interface AppState {
  obs: ObsState;
  x32: X32State;
  proclaim: ProclaimState;
}

export interface Config {
  server: {
    port: number;
  };
  obs: {
    address: string;
    password: string;
    screenshotInterval: number;
  };
  x32: {
    address: string;
    port: number;
  };
  proclaim: {
    host: string;
    port: number;
    password: string;
    pollInterval: number;
  };
  ui: {
    hiddenObs: string[];
    hiddenX32: string[];
  };
}

export interface ObsConnection {
  connect(): Promise<void>;
  disconnect(): void;
  setScene(sceneName: string): Promise<void>;
  setInputVolume(inputName: string, volumeDb: number): Promise<void>;
  toggleMute(inputName: string): Promise<void>;
  toggleStream(): Promise<void>;
  toggleRecord(): Promise<void>;
  getSceneScreenshot(sceneName: string): Promise<Buffer>;
}

export interface X32Connection {
  connect(): void;
  disconnect(): void;
  setFader(channelIndex: number, value: number, type?: 'ch' | 'bus' | 'main' | 'mtx'): void;
  toggleMute(channelIndex: number, type?: 'ch' | 'bus' | 'main' | 'mtx'): void;
  parseOscMessage(address: string, args: Array<{ value: unknown }>): { index: number; type: 'ch' | 'bus' | 'main' | 'mtx'; patch: Partial<Channel> } | null;
  startMeterUpdates(): void;
  stopMeterUpdates(): void;
}

export interface ProclaimConnection {
  connect(): Promise<void>;
  disconnect(): void;
  sendAction(commandName: string, index?: number): Promise<boolean>;
  goToItem(itemId: string): Promise<boolean>;
  getThumbUrl(itemId: string | undefined, slideIndex: string | undefined, localRevision: string | undefined): string;
  getToken(): string | null;
  getOnAirSessionId(): string | null;
}

export interface Connections {
  obs: ObsConnection;
  x32: X32Connection;
  proclaim: ProclaimConnection;
}

export interface ChangeEvent {
  section: keyof AppState;
  state: AppState;
}
