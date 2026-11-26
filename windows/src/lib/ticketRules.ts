// Which Keito project (and task) a Jira ticket books on. Pure logic, no network: the form calls it
// when you pick a ticket, and once more when the ticket's Jira organisation is known.
import { projectIdOf, taskIdOf, type JiraIssue, type Project, type TaskItem, type TimeEntry } from "./models";

const KEY = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;

/**
 * Tickets you logged time on, newest first, each once: the quickest pick in the ticket field. The title comes
 * from the entry's link ("CSD-12 Printer offline" → "Printer offline"). `history` is newest first.
 */
export function recentTicketsOf(history: TimeEntry[], limit: number): JiraIssue[] {
  const out: JiraIssue[] = [];
  const seen = new Set<string>();
  for (const e of history) {
    const ref = e.external_reference;
    const key = ref?.id?.toUpperCase();
    if (!key || !KEY.test(key) || seen.has(key)) continue;
    seen.add(key);
    const name = ref?.display_name?.trim() ?? "";
    const summary = name.toUpperCase().startsWith(key) ? name.slice(key.length).replace(/^[\s:–-]+/, "") : name;
    out.push({ key, summary });
    if (out.length >= limit) break;
  }
  return out;
}

/** Ticket prefixes that always book on one project, found by name. CSD = the service-desk Jira project. */
export const FIXED_PREFIXES: { prefix: string; project: RegExp; client?: RegExp }[] = [
  { prefix: "CSD", project: /service\s*-?\s*desk/i, client: /customer\s*support/i },
];

export interface TicketSuggestion {
  project: Project;
  task?: TaskItem;
  /** The prefix always books here (CSD): it wins over a project you already had in the form. */
  fixed: boolean;
  reason: string;
}

export const prefixOf = (key: string) => key.split("-")[0]?.toUpperCase() ?? "";

/** The project for a fixed prefix: by name, the one with the matching client first. */
export function fixedProject(key: string, projects: Project[]): Project | undefined {
  const rule = FIXED_PREFIXES.find((r) => r.prefix === prefixOf(key));
  if (!rule) return undefined;
  const hits = projects.filter((p) => rule.project.test(p.name));
  if (hits.length <= 1) return hits[0];
  return (rule.client && hits.find((p) => rule.client!.test(p.client?.name ?? ""))) ?? hits[0];
}

/**
 * Where a ticket books, strongest first:
 * 1. this exact ticket was logged before → same project and task;
 * 2. a fixed prefix (CSD → Service Desk);
 * 3. another ticket with the same prefix was logged before → that project.
 * `history` is newest first.
 */
export function suggestForTicket(key: string, projects: Project[], history: TimeEntry[]): TicketSuggestion | undefined {
  const k = key.toUpperCase();
  const prefix = prefixOf(k);
  const fixed = fixedProject(k, projects);
  const refOf = (e: TimeEntry) => e.external_reference?.id?.toUpperCase() ?? "";
  const byId = (id: string | undefined) => (id ? projects.find((p) => p.id === id) : undefined);

  const same = history.find((e) => refOf(e) === k && byId(projectIdOf(e)));
  const sameProject = same && byId(projectIdOf(same));
  // A fixed prefix only takes history from that same project (an old entry on another project was a mistake).
  if (same && sameProject && (!fixed || fixed.id === sameProject.id)) {
    const tid = taskIdOf(same);
    const task = sameProject.tasks?.find((t) => t.id === tid)
      ?? (same.task && tid ? { id: tid, name: same.task.name ?? "Task" } : undefined);
    return { project: sameProject, task, fixed: !!fixed, reason: "Logged like this before" };
  }
  if (fixed) return { project: fixed, fixed: true, reason: `${prefix} → ${fixed.name}` };

  const sibling = history.find((e) => prefixOf(refOf(e)) === prefix && refOf(e).includes("-") && byId(projectIdOf(e)));
  const siblingProject = sibling && byId(projectIdOf(sibling));
  if (siblingProject) return { project: siblingProject, fixed: false, reason: `Like earlier ${prefix} tickets` };
  return undefined;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Legal-form noise that differs between Jira and Keito ("Acme B.V." vs "Acme"). */
const NOISE = new Set(["bv", "nv", "vof", "gmbh", "ltd", "inc", "holding", "group", "groep"]);
/** "Acme B.V." → "acme": lower case, no punctuation, no legal form ("B.V." splits into "b" and "v"). */
const core = (s: string) => {
  const words = norm(s).split(" ").filter(Boolean);
  const out = words.filter((w, i) => !NOISE.has(w) && !(w.length === 1 && (words[i - 1]?.length === 1 || words[i + 1]?.length === 1)));
  return out.join(" ");
};

/**
 * The task named after the ticket's customer (in the service-desk setup the task is the customer).
 * Only a single clear match: exact name first, then one task whose name contains the organisation or the
 * other way round. Anything less certain returns undefined, and you pick the task yourself.
 */
export function taskForOrganization(orgs: string[], tasks: TaskItem[]): TaskItem | undefined {
  for (const org of orgs) {
    const o = core(org);
    if (o.length < 2) continue;
    const exact = tasks.filter((t) => core(t.name) === o);
    if (exact.length === 1) return exact[0];
    const loose = tasks.filter((t) => {
      const c = core(t.name);
      return c.length >= 3 && (c.includes(o) || o.includes(c));
    });
    if (loose.length === 1) return loose[0];
  }
  return undefined;
}
