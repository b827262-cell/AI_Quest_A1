export declare function artifactPath(name: string, envName?: string): string;
export declare function commitSha(): string;
export declare function releaseMetadata(environmentLabel?: string): {
  timestamp: string;
  commitSha: string;
  environmentLabel: string;
  runnerId: string;
  runnerEnvironment: { platform: string; arch: string; node: string; ci: boolean };
};
export declare function redactText(value: unknown): string;
export declare function sanitizeDiagnostic(value: unknown, maxLength?: number): string;
export declare function scanArtifactText(text: unknown): { passed: boolean; reason?: string };
export declare function writeSanitizedArtifact(filePath: string, payload: unknown): {
  written: boolean;
  leakage: string;
  reason?: string;
};
export declare const root: string;
