import { describe, expect, it, vi } from "vitest";

vi.mock("./native", () => ({ http: vi.fn(), native: { logProblem: vi.fn(() => Promise.resolve()) }, openExternal: vi.fn(), secrets: { get: vi.fn(), set: vi.fn() } }));

import { problemLine, reportProblem } from "./problems";
import { native } from "./native";
import { shouldRestart } from "../Recover";

describe("problem log", () => {
  it("one line: time, window, kind, message, stacks", () => {
    const e = new TypeError("n is not a function");
    e.stack = "TypeError: n is not a function\n    at Lo (index.js:40:22339)\n    at br (index.js:40:24030)";
    const line = problemLine("notch", "ui crash", e, "\n    at EntryForm\n    at div\n    at NotchApp", new Date("2026-11-26T10:00:00Z"));
    expect(line).toBe(
      "2026-11-26T10:00:00.000Z · notch · ui crash · TypeError: n is not a function · " +
        "stack: TypeError: n is not a function < at Lo (index.js:40:22339) < at br (index.js:40:24030) · " +
        "components: at EntryForm < at div < at NotchApp",
    );
  });

  it("non-Error values are logged as text", () => {
    expect(problemLine("toast", "unhandled promise", "offline", null, new Date(0))).toBe("1970-01-01T00:00:00.000Z · toast · unhandled promise · offline");
  });

  it("stops after 50 lines per run, so a crash loop can't fill the disk", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (let i = 0; i < 60; i++) reportProblem("error", new Error(`e${i}`));
    expect(vi.mocked(native.logProblem)).toHaveBeenCalledTimes(50);
    quiet.mockRestore();
  });
});

describe("Recover: start again after a crash, but not in a loop", () => {
  it("restarts up to 5 crashes a minute", () => {
    const now = 1_000_000;
    expect(shouldRestart([now], now)).toBe(true);
    expect(shouldRestart([now - 4000, now - 3000, now - 2000, now - 1000, now], now)).toBe(true);
    expect(shouldRestart([now - 5000, now - 4000, now - 3000, now - 2000, now - 1000, now], now)).toBe(false);
    expect(shouldRestart([now - 120_000, now - 90_000, now - 80_000, now - 70_000, now - 61_000, now], now)).toBe(true);
  });
});
