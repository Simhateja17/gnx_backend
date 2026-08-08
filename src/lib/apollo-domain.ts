/**
 * Domain normalization for Apollo lookups.
 *
 * Deliberately its own module rather than part of lib/apollo: that one is the
 * HTTP client and gets mocked wholesale in tests, and a pure string helper
 * should not disappear along with the network layer. Both the person-match and
 * bulk-match request builders depend on this, so it also has to sit somewhere
 * neither of them imports the other to reach.
 */
export function normalizeApolloDomain(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;

  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    // Not a parseable URL - strip the pieces we know about and take the host.
    return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] || null;
  }
}
