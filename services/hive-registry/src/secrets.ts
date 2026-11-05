// The registry holds a catalog and lookup links, never credentials. This runs on the
// raw request before schema validation, so a credential is refused by name or by shape
// even in a field that would otherwise be rejected. It never echoes what it found.
const forbiddenKey = /pass(word|phrase|wd)?$|secret|token|api[-_]?key|private[-_]?key|credential|authorization|cookie|session|bearer|signing[-_]?key/i;
const digestFields = new Set(['manifestDigest', 'planDigest', 'imageDigest']);
const forbiddenValue: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY/, // PEM private key
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/, // JSON Web Token
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i, // Authorization header value
  /[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]*@/i, // URL with an embedded password
  /[?&](token|secret|password|key|api[-_]?key|access[-_]?token)=/i, // credential in a query
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/, // common API key prefixes
  /\b(ghp|gho|ghs|ghu|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
const opaque = /[A-Za-z0-9_-]{40,}/g;

function looksLikeOpaqueCredential(value: string): boolean {
  // A pinned image digest is a long hex string by design and is not a credential.
  const stripped = value.replace(/sha256:[a-f0-9]{64}/g, '');
  // Long hyphenated names, such as an installation id, are not opaque; base64url keys
  // and hex tokens have few or no separators.
  return (stripped.match(opaque) ?? []).some((candidate) => /[0-9]/.test(candidate) && /[A-Za-z]/.test(candidate) && candidate.split(/[-_]/).length <= 3);
}

/** Returns the JSON path of the first credential-like value, or null when clean. */
export function findSecret(value: unknown, path = '$', key = ''): string | null {
  if (typeof value === 'string') {
    if (forbiddenValue.some((pattern) => pattern.test(value))) return path;
    if (!digestFields.has(key) && looksLikeOpaqueCredential(value)) return path;
    return null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSecret(item, `${path}[${index}]`, key);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) {
      const next = `${path}.${name}`;
      if (forbiddenKey.test(name)) return next;
      const found = findSecret(item, next, name);
      if (found) return found;
    }
  }
  return null;
}
