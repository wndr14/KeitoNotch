import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/native", () => ({ http: vi.fn(), native: {}, openExternal: vi.fn(), secrets: { get: vi.fn(), set: vi.fn() } }));

import { ticketKeyIn } from "./NotchApp";

describe("ticketKeyIn: Ctrl+V in the day view", () => {
  it.each([
    ["CSD-1234", "CSD-1234"],
    ["  csd-77 \n", "CSD-77"],
    ["https://example.atlassian.net/browse/CSD-1234", "CSD-1234"],
    ["https://x.atlassian.net/jira/servicedesk/projects/CSD/queues/custom/1?selectedIssue=CSD-9", "CSD-9"],
  ])("%s → %s", (text, key) => expect(ticketKeyIn(text)).toBe(key));

  it.each(["", "hello world", "CSD 1234", "1:30", "https://example.com/"])("%j → nothing", (text) => expect(ticketKeyIn(text)).toBeNull());
});
