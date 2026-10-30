export const MAX_ARCHIVE_BYTES: number;
export function readArchive(bytes: Uint8Array): Array<{ name: string; directory: boolean; bytes: Buffer }>;
export function extractArchive(bytes: Uint8Array, destination: string): void;
export function boundedResponse(response: Response, limit: number): Promise<Buffer>;
