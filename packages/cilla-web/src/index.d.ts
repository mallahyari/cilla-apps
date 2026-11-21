export interface CillaProgress {
  loaded: number;
  total: number;
  ratio: number;
  fromCache: boolean;
}

export interface CillaBrowserTTSOptions {
  modelBaseUrl?: string;
  voices?: string[];
  defaultVoice?: string;
}

export interface CillaEnqueueOptions {
  voice?: string;
  temperature?: number;
  seed?: number;
  onFirstAudio?: (ms: number) => void;
}

export function isModelCached(modelBaseUrl?: string): Promise<boolean>;

export class CillaBrowserTTS {
  readonly isLoaded: boolean;
  speaking: boolean;
  onSpeakingChange: ((speaking: boolean) => void) | null;
  constructor(options?: CillaBrowserTTSOptions);
  load(options?: { onProgress?: (progress: CillaProgress) => void }): Promise<unknown>;
  unlock(): void;
  getOutputLevel(): number;
  getOutputFrequencyData(out: Uint8Array): void;
  enqueue(text: string, options?: CillaEnqueueOptions): void;
  stop(): void;
}
