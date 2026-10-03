import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRequestRange } from "./httpRange";

const TOTAL = 1000;

describe("resolveRequestRange", () => {
  describe("no header → full 200", () => {
    it("undefined header serves the full body", () => {
      assert.deepEqual(resolveRequestRange(undefined, TOTAL), { kind: "full" });
    });

    it("null header serves the full body", () => {
      assert.deepEqual(resolveRequestRange(null, TOTAL), { kind: "full" });
    });
  });

  describe("normal ranges → 206", () => {
    it("bytes=0-99 → first 100 bytes", () => {
      assert.deepEqual(resolveRequestRange("bytes=0-99", TOTAL), {
        kind: "range",
        start: 0,
        end: 99,
      });
    });

    it("bytes=200-499 → middle window", () => {
      assert.deepEqual(resolveRequestRange("bytes=200-499", TOTAL), {
        kind: "range",
        start: 200,
        end: 499,
      });
    });

    it("open-ended bytes=500- → through the last byte", () => {
      assert.deepEqual(resolveRequestRange("bytes=500-", TOTAL), {
        kind: "range",
        start: 500,
        end: TOTAL - 1,
      });
    });

    it("end beyond the resource is clamped to total-1", () => {
      assert.deepEqual(resolveRequestRange("bytes=900-99999", TOTAL), {
        kind: "range",
        start: 900,
        end: TOTAL - 1,
      });
    });

    it("single-byte range bytes=0-0", () => {
      assert.deepEqual(resolveRequestRange("bytes=0-0", TOTAL), {
        kind: "range",
        start: 0,
        end: 0,
      });
    });

    it("last byte exactly: bytes=999-999", () => {
      assert.deepEqual(resolveRequestRange("bytes=999-999", TOTAL), {
        kind: "range",
        start: 999,
        end: 999,
      });
    });

    it("surrounding whitespace is tolerated", () => {
      assert.deepEqual(resolveRequestRange("  bytes=0-99  ", TOTAL), {
        kind: "range",
        start: 0,
        end: 99,
      });
    });
  });

  describe("suffix ranges bytes=-N → 206", () => {
    it("bytes=-100 → last 100 bytes", () => {
      assert.deepEqual(resolveRequestRange("bytes=-100", TOTAL), {
        kind: "range",
        start: 900,
        end: TOTAL - 1,
      });
    });

    it("suffix larger than the resource clamps to the whole body", () => {
      assert.deepEqual(resolveRequestRange("bytes=-5000", TOTAL), {
        kind: "range",
        start: 0,
        end: TOTAL - 1,
      });
    });
  });

  describe("unsatisfiable ranges → 416", () => {
    it("start at total is out of range", () => {
      assert.deepEqual(resolveRequestRange(`bytes=${TOTAL}-`, TOTAL), {
        kind: "unsatisfiable",
      });
    });

    it("start beyond total is out of range", () => {
      assert.deepEqual(resolveRequestRange("bytes=99999-100000", TOTAL), {
        kind: "unsatisfiable",
      });
    });

    it("zero-length suffix bytes=-0 is unsatisfiable", () => {
      assert.deepEqual(resolveRequestRange("bytes=-0", TOTAL), {
        kind: "unsatisfiable",
      });
    });

    it("any range against an empty resource is unsatisfiable", () => {
      assert.deepEqual(resolveRequestRange("bytes=0-99", 0), {
        kind: "unsatisfiable",
      });
      assert.deepEqual(resolveRequestRange("bytes=-100", 0), {
        kind: "unsatisfiable",
      });
    });
  });

  describe("malformed headers are ignored → full 200 (RFC 7233)", () => {
    const malformed = [
      "bytes=-", // both sides empty
      "bytes=", // no spec at all
      "bytes", // missing =
      "bytes=abc-def", // non-numeric
      "bytes=1.5-2", // non-integer
      "bytes=0-99,200-299", // multi-range (unsupported)
      "items=0-99", // unknown unit
      "0-99", // no unit
      "bytes=500-100", // start > end (invalid spec)
      "bytes=--5", // double dash
      "", // empty string
    ];

    for (const header of malformed) {
      it(`ignores ${JSON.stringify(header)}`, () => {
        assert.deepEqual(resolveRequestRange(header, TOTAL), { kind: "full" });
      });
    }
  });
});
