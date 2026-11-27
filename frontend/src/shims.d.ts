/// <reference types="vite/client" />

declare module 'hic-straw' {
  export interface StrawConfig {
    url?: string;
    file?: File | Blob;
    blob?: Blob;
  }

  export interface StrawChrom {
    index: number;
    name: string;
    size: number;
  }

  export interface StrawMetaData {
    version: number;
    genome: string;
    chromosomes: StrawChrom[];
    resolutions: number[];
  }

  export interface StrawContactRecord {
    bin1: number;
    bin2: number;
    counts: number;
  }

  export default class Straw {
    constructor(config: StrawConfig);
    getMetaData(): Promise<StrawMetaData>;
    getNormalizationOptions(): Promise<string[]>;
    getContactRecords(
      normalization: string,
      region1: { chr: string; start: number; end: number },
      region2: { chr: string; start: number; end: number },
      units: 'BP' | 'FRAG',
      binsize: number
    ): Promise<StrawContactRecord[]>;
  }
}
