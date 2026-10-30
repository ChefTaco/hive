const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

export function parseVersion(value: string): readonly [number, number, number] {
  const match = versionPattern.exec(value);
  if (!match) throw new Error('Hermes compatibility versions must use semantic versioning');
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left); const b = parseVersion(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return 0;
}

export function compatibleVersion(version: string | undefined, minimum: string | null | undefined, maximum: string | null | undefined): boolean {
  if (!minimum && !maximum) return true;
  if (!version) return false;
  try { return (!minimum || compareVersions(version, minimum) >= 0) && (!maximum || compareVersions(version, maximum) <= 0); }
  catch { return false; }
}
