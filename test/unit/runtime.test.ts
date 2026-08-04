/**
 * The runtime version notice.
 *
 * `engines.node` is `>=24`, but npm only *warns* about a mismatch — so an
 * older Node installs cleanly and then behaves like a supported one until
 * something unrelated breaks. This is the warning that says so.
 *
 * The version is injected rather than faked with a subprocess: no network and
 * no spawning in unit tests (CLAUDE.md). The two call-site tests redefine
 * `process.versions.node`, which is non-writable but configurable.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MINIMUM_NODE_MAJOR,
  warnIfUnsupportedNode,
} from "../../src/runtime.js";
import {
  MockProvider,
  completeValidatedJSON,
  makeProvider,
  resetNodeVersionWarning,
} from "../../src/index.js";

const realNodeVersion = process.versions.node;

function pretendNodeIs(version: string): void {
  Object.defineProperty(process.versions, "node", {
    value: version,
    writable: false,
    enumerable: true,
    configurable: true,
  });
}

describe("Node version notice", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetNodeVersionWarning();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    pretendNodeIs(realNodeVersion);
    resetNodeVersionWarning();
  });

  it("stays in step with engines.node", () => {
    // The constant and package.json are two statements of one fact. If the
    // support floor moves, both move — this is what makes them move together.
    const declared = JSON.parse(readFileSync("package.json", "utf8")) as {
      engines: { node: string };
    };
    expect(declared.engines.node).toBe(`>=${MINIMUM_NODE_MAJOR}`);
  });

  it("warns once on a Node older than the declared minimum", () => {
    warnIfUnsupportedNode("22.11.0");
    warnIfUnsupportedNode("22.11.0");
    warnIfUnsupportedNode("20.9.0");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("names the running version, the required version, and what to do", () => {
    warnIfUnsupportedNode("22.11.0");
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("inference:");
    expect(message).toContain("22.11.0");
    expect(message).toContain(`Node ${MINIMUM_NODE_MAJOR}`);
    expect(message).toMatch(/upgrade Node/i);
  });

  it("says nothing on a supported Node", () => {
    warnIfUnsupportedNode(`${MINIMUM_NODE_MAJOR}.0.0`);
    warnIfUnsupportedNode(`${MINIMUM_NODE_MAJOR + 4}.1.2`);
    expect(warn).not.toHaveBeenCalled();
  });

  it("says nothing when the version cannot be read", () => {
    // Same rule as an unknown model price: never guess. A runtime that does
    // not report a Node version is not evidence of an old one.
    warnIfUnsupportedNode("");
    warnIfUnsupportedNode("not-a-version");
    expect(warn).not.toHaveBeenCalled();
  });

  it("re-arms after resetNodeVersionWarning", () => {
    warnIfUnsupportedNode("22.11.0");
    resetNodeVersionWarning();
    warnIfUnsupportedNode("22.11.0");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("fires from provider construction", () => {
    pretendNodeIs("22.11.0");
    makeProvider({ provider: "mock" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("22.11.0");
  });

  it("fires from a completion, for consumers that build providers directly", () => {
    pretendNodeIs("22.11.0");
    return completeValidatedJSON({
      provider: new MockProvider([{ json: { ok: true } }], "mock-model"),
      system: "s",
      user: "u",
      schema: { type: "object" },
    }).then(() => {
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("22.11.0");
    });
  });
});
