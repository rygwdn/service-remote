export interface AudioSource {
  name: string;
  volume: number;
  muted: boolean;
}

export interface Channel {
  index: number;
  type: 'ch' | 'bus';
  label: string;
  fader: number;
  muted: boolean;
}

export interface ServiceItem {
  id: string;
  title: string;
  kind: string;
  slideCount: number;
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
  setFader(channelIndex: number, value: number, type?: 'ch' | 'bus'): void;
  toggleMute(channelIndex: number, type?: 'ch' | 'bus'): void;
  parseOscMessage(address: string, args: Array<{ value: unknown }>): { index: number; type: 'ch' | 'bus'; patch: Partial<Channel> } | null;
}

export interface ProclaimConnection {
  connect(): Promise<void>;
  disconnect(): void;
  sendAction(commandName: string, index?: number): Promise<boolean>;
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
