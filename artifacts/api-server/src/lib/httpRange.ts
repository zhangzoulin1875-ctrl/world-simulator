/**
 * Pure single-range HTTP Range header resolution for the game music
 * streaming endpoint (GET /api/storage/music/:id). Extracted so seek
 * behaviour (206/416/ignore) is unit-testable and doesn't silently break.
 *
 * Only single ranges of the form "bytes=start-end" are supported — that is
 * all browsers send for <audio> seeking.
 *
 * Semantics (RFC 7233):
 * - No header, or a malformed/unparseable header (wrong unit, multiple
 *   ranges, start > end, garbage) → the header is ignored and the full
 *   resource is served with 200.
 * - A well-formed but unsatisfiable range (start beyond the end of the
 *   resource, or a zero-length suffix) → 416 with the total-only
 *   Content-Range form.
 * - Otherwise → 206 with the clamped [start, end] byte window (inclusive).
 */
export type ResolvedRange =
  | { kind: "full" }
  | { kind: "range"; start: number; end: number }
  | { kind: "unsatisfiable" };

const SINGLE_RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

export function resolveRequestRange(
  rangeHeader: string | undefined | null,
  totalBytes: number,
): ResolvedRange {
  if (rangeHeader === undefined || rangeHeader === null) {
    return { kind: "full" };
  }

  const match = SINGLE_RANGE_PATTERN.exec(rangeHeader.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    // Malformed / unsupported (e.g. multi-range, non-bytes unit, "bytes=-"):
    // per RFC 7233 the header is ignored and the full body served.
    return { kind: "full" };
  }

  if (match[1] === "") {
    // Suffix range "bytes=-N": last N bytes.
    const suffix = Number(match[2]);
    if (suffix <= 0) {
      // "bytes=-0" is well-formed but unsatisfiable.
      return { kind: "unsatisfiable" };
    }
    if (totalBytes <= 0) {
      return { kind: "unsatisfiable" };
    }
    return {
      kind: "range",
      start: Math.max(0, totalBytes - suffix),
      end: totalBytes - 1,
    };
  }

  const start = Number(match[1]);
  const end = match[2] === "" ? totalBytes - 1 : Number(match[2]);

  if (start >= totalBytes) {
    // Well-formed but beyond the end of the resource (covers open-ended
    // "bytes=N-" where N >= total, and the empty-resource case).
    return { kind: "unsatisfiable" };
  }
  if (start > end) {
    // Invalid byte-range-spec (first > last) → ignore the header (200).
    return { kind: "full" };
  }
  return { kind: "range", start, end: Math.min(end, totalBytes - 1) };
}
