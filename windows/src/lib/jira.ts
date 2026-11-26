// Jira Cloud REST v3 — port of JiraClient.swift.
import { http } from "./native";
import { hasJira, type Credentials } from "./prefs";
import { APIError } from "./keito";
import type { JiraIssue } from "./models";

const KEY = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;

export const looksLikeKey = (s: string) => KEY.test(s);

/** The ticket key in a pasted Jira link: ".../browse/ABC-123", "...?selectedIssue=ABC-123". */
export function keyFromLink(s: string): string | null {
  let u: URL;
  try {
    u = new URL(s.trim());
  } catch {
    return null;
  }
  if (!u.protocol.startsWith("http") || !u.host) return null;
  const candidates = [...u.searchParams.getAll("selectedIssue"), ...u.pathname.split("/").filter(Boolean).reverse()];
  return candidates.find(looksLikeKey)?.toUpperCase() ?? null;
}

interface RawIssue {
  key: string;
  fields: { summary?: string; status?: { name?: string } };
}

const toIssue = (r: RawIssue): JiraIssue => ({ key: r.key, summary: r.fields.summary ?? "", status: r.fields.status?.name });

interface RawField {
  id: string;
  schema?: { custom?: string };
}

/** Jira Service Management's "Organizations" field. */
export const ORG_FIELD_TYPE = "com.atlassian.servicedesk:sd-customer-organizations";
const orgFieldCache = new Map<string, Promise<string | null>>();

/** Names from the Organizations field value: [{ id, name }, …]. */
export function organizationNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((o) => (o && typeof o === "object" && typeof (o as { name?: unknown }).name === "string" ? (o as { name: string }).name.trim() : ""))
    .filter(Boolean);
}

export class JiraClient {
  constructor(private creds: Credentials) {}

  browseUrl(key: string) {
    return `https://${this.creds.jiraHost}/browse/${key}`;
  }

  private async get(path: string, query: Record<string, string>): Promise<unknown> {
    if (!hasJira(this.creds)) throw new Error("Jira is not configured. Open Settings.");
    const url = new URL(path, `https://${this.creds.jiraHost}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const basic = btoa(unescape(encodeURIComponent(`${this.creds.jiraEmail}:${this.creds.jiraToken}`)));
    const resp = await http(url.toString(), { headers: { Authorization: `Basic ${basic}`, Accept: "application/json" } });
    const text = await resp.text();
    if (!resp.ok) throw new APIError(resp.status, text);
    return JSON.parse(text);
  }

  /** The signed-in user's display name (tests the connection). */
  async myself(): Promise<string> {
    const me = (await this.get("/rest/api/3/myself", {})) as { displayName?: string };
    return me.displayName ?? this.creds.jiraEmail;
  }

  /** Open tickets assigned to you, most recently updated first. */
  myOpenIssues(limit = 50) {
    return this.jql("assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC", limit);
  }

  /** Key-like query → that issue; otherwise a summary search. */
  async search(raw: string): Promise<JiraIssue[]> {
    const q = raw.trim();
    if (!q) return [];
    if (looksLikeKey(q)) {
      try {
        return [await this.issue(q.toUpperCase())];
      } catch {
        return [];
      }
    }
    const escaped = q.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return this.jql(`summary ~ "${escaped}*" ORDER BY updated DESC`, 15);
  }

  async issue(key: string): Promise<JiraIssue> {
    return toIssue((await this.get(`/rest/api/3/issue/${key}`, { fields: "summary,status" })) as RawIssue);
  }

  /**
   * The customer organisations on a Jira Service Management ticket (CSD: the customer you work for).
   * The field id differs per site, so it's looked up once by its type. Empty when there is none.
   */
  async organizations(key: string): Promise<string[]> {
    const field = await this.organizationField();
    if (!field) return [];
    const r = (await this.get(`/rest/api/3/issue/${key}`, { fields: field })) as { fields?: Record<string, unknown> };
    return organizationNames(r.fields?.[field]);
  }

  private organizationField(): Promise<string | null> {
    const cacheKey = this.creds.jiraHost;
    let found = orgFieldCache.get(cacheKey);
    if (!found) {
      found = (this.get("/rest/api/3/field", {}) as Promise<RawField[]>)
        .then((fields) => fields.find((f) => f.schema?.custom === ORG_FIELD_TYPE)?.id ?? null);
      // A failed lookup is retried next time, not remembered.
      found.catch(() => orgFieldCache.delete(cacheKey));
      orgFieldCache.set(cacheKey, found);
    }
    return found;
  }

  private async jql(jql: string, limit: number): Promise<JiraIssue[]> {
    const r = (await this.get("/rest/api/3/search/jql", { jql, fields: "summary,status", maxResults: String(limit) })) as {
      issues: RawIssue[];
    };
    return r.issues.map(toIssue);
  }
}
