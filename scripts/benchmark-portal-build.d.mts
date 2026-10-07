export type BuildFile = {path: string; bytes: number; gzip_bytes: number; sha256: string};
export type BuildMeasurement = {entries: string[]; files: BuildFile[]; bytes: number; gzip_bytes: number};
export function measurePortalBuild(directory: string): BuildMeasurement;
export function comparePortalBuilds<B extends {gzip_bytes: number}, C extends {gzip_bytes: number}>(baseline: B, candidate: C, maximumRatio?: number): {
  baseline: B; candidate: C; gzip_ratio: number; maximum_ratio: number; payload_threshold_passed: boolean; scope: string;
};
