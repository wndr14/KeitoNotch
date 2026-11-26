// New / edit entry (392×600): project, task, Jira ticket, notes, duration + date. Keyboard driven.
// Port of EntryFormView.swift (without favourites).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { store, useStore, type Timing } from "../lib/store";
import { savePrefs, type Favorite } from "../lib/prefs";
import { keyFromLink } from "../lib/jira";
import { meetingTask } from "../lib/matcher";
import { taskForOrganization } from "../lib/ticketRules";
import { addDays, fromKey, isToday, shortDay, startOfDay } from "../lib/dates";
import * as fmt from "../lib/duration";
import type { ExternalReference, JiraIssue, Project, TaskItem } from "../lib/models";
import { CalendarIcon, ChevronDown, ChevronLeft, ChevronRight, Close, Play, Star, Trash } from "../icons";
import { IconButton, Kbd, ProjectDot, Spinner, TicketChip } from "./parts";
import type { Nav } from "./NotchApp";

type Field = "project" | "task" | "jira" | "notes" | "time";

const FAV = "fav:";

interface DropItem {
  id: string;
  star?: boolean;
  title: string;
  detail?: string | null;
  dot?: string;
  ticket?: string;
}
interface DropSection {
  title?: string;
  items: DropItem[];
}

export function EntryForm({ nav }: { nav: Nav }) {
  const s = useStore();
  const seed = nav.form;
  const editing = seed.editing ?? null;
  const event = seed.event ?? null;

  const [project, setProject] = useState<Project | null>(null);
  const [projectQuery, setProjectQuery] = useState("");
  const [projectHl, setProjectHl] = useState(0);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [task, setTask] = useState<TaskItem | null>(null);
  const [taskQuery, setTaskQuery] = useState("");
  const [taskHl, setTaskHl] = useState(0);
  const [date, setDate] = useState(startOfDay(seed.date));
  const [timeText, setTimeText] = useState("");
  const [billable, setBillable] = useState(true);
  const [billableEdited, setBillableEdited] = useState(false);
  const [jiraQuery, setJiraQuery] = useState("");
  const [jiraIssue, setJiraIssue] = useState<JiraIssue | null>(null);
  const [jiraMine, setJiraMine] = useState<JiraIssue[]>([]);
  const [jiraOther, setJiraOther] = useState<JiraIssue[]>([]);
  /** Tickets you logged time on lately (from your entries), after your open ones. */
  const [jiraRecent, setJiraRecent] = useState<JiraIssue[]>([]);
  const [jiraHl, setJiraHl] = useState(0);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [existingRef, setExistingRef] = useState<ExternalReference | null>(null);
  const [notes, setNotes] = useState("");
  const [notesFromTicket, setNotesFromTicket] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [focus, setFocus] = useState<Field | null>(null);
  /** Task to pick once the project's tasks are loaded. */
  const preferredTask = useRef<TaskItem | null>(null);
  /** A ticket set the project but not the task (CSD, customer unknown): don't fall back to the last task. */
  const ticketNeedsTask = useRef(false);
  /** You picked the project yourself (or are editing): only a fixed prefix (CSD) still moves it. */
  const projectChosen = useRef(false);
  /** Bumped per ticket, so a slow customer lookup for an older ticket is ignored. */
  const ticketSeq = useRef(0);
  /** Why the ticket moved the project, shown next to the ticket. */
  const [ticketReason, setTicketReason] = useState<string | null>(null);
  const latest = useRef({ project, tasks, task });
  latest.current = { project, tasks, task };

  const refs = {
    project: useRef<HTMLInputElement>(null),
    task: useRef<HTMLInputElement>(null),
    jira: useRef<HTMLInputElement>(null),
    notes: useRef<HTMLTextAreaElement>(null),
    time: useRef<HTMLInputElement>(null),
  };
  const focusField = (f: Field) => window.setTimeout(() => refs[f].current?.focus(), 0);

  const editingRunning = !!editing && editing.id === s.running?.id;
  const defaultBillable = task?.billable ?? project?.is_billable ?? true;

  // MARK: Prefill (once)

  useEffect(() => {
    store.clearError();
    if (editing) {
      const p = store.projectFor(editing)
        ?? (editing.project ? { id: editing.project.id, name: editing.project.name ?? "Project" } : null);
      setNotes(editing.notes ?? "");
      const d = editing.spent_date ? fromKey(editing.spent_date) : null;
      if (d) setDate(d);
      if (!editingRunning && editing.hours != null) setTimeText(fmt.hoursLabel(editing.hours));
      const ref = editing.external_reference;
      if (ref) {
        setExistingRef(ref);
        const title = ref.display_name?.startsWith(ref.id) ? ref.display_name.slice(ref.id.length) : ref.display_name ?? "";
        setJiraIssue({ key: ref.id, summary: title.trim() });
      }
      if (editing.billable != null) {
        setBillable(editing.billable);
        setBillableEdited(true);
      }
      if (editing.task) preferredTask.current = { id: editing.task.id, name: editing.task.name ?? "Task" };
      projectChosen.current = true;
      setProject(p);
      focusField("notes");
      return;
    }
    if (event) {
      // Duration and notes from the meeting; project/task/ticket only when confident.
      const m = store.match(event);
      setTimeText(fmt.hoursLabel((+event.end - +event.start) / 3600_000));
      setNotes(event.title);
      if (m.jiraKey) setJiraIssue(store.myJiraIssues.find((i) => i.key === m.jiraKey) ?? { key: m.jiraKey, summary: event.title });
      preferredTask.current = m.task ?? null;
      if (m.project) {
        setProject(m.project);
        focusField("time");
      } else {
        focusField("project");
      }
      return;
    }
    const lastId = store.prefs.lastProjectId ?? store.running?.project_id ?? store.running?.project?.id;
    const p = lastId ? store.projects.find((x) => x.id === lastId) : undefined;
    if (p) {
      setProject(p);
      focusField("notes");
    } else {
      focusField("project");
    }
    // Jira set up: start in the ticket field, so your open and recent tickets are one click away.
    if (store.hasJira && !seed.ticket) focusField("jira");
    // Opened with a pasted Jira link or key (Ctrl+V in the day view): link it, which also picks the project.
    if (seed.ticket) {
      const key = seed.ticket;
      if (!store.hasJira) {
        setNotes(key);
        return;
      }
      const mine = store.myJiraIssues.find((i) => i.key === key);
      setJiraIssue(mine ?? { key, summary: "" });
      void (mine ? Promise.resolve(mine) : store.jira.issue(key))
        .then((issue) => pickIssue(issue))
        .catch(() => {
          // Unknown or no access: keep the key so you see what was pasted.
          setJiraIssue(null);
          setJiraQuery(key);
          focusField("jira");
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // MARK: Tasks follow the project

  useEffect(() => {
    const keep = task ?? preferredTask.current;
    setTask(null);
    setTasks([]);
    if (!project) return;
    if (!editing) savePrefs({ lastProjectId: project.id });
    let cancelled = false;
    setTasksLoading(true);
    void store.tasksFor(project).then((loaded) => {
      if (cancelled) return;
      setTasksLoading(false);
      setTasks(loaded);
      // A CSD ticket without a known customer: the last task is probably another customer, so ask.
      const needsTask = ticketNeedsTask.current;
      ticketNeedsTask.current = false;
      const lastTask = editing || needsTask ? null : store.prefs.lastTaskId;
      const pick = loaded.find((t) => t.id === keep?.id)
        ?? (event ? meetingTask(loaded) : undefined)
        ?? loaded.find((t) => t.id === lastTask)
        ?? (loaded.length === 1 ? loaded[0] : undefined)
        ?? null;
      setTask(pick);
      preferredTask.current = null;
      // No obvious task: go straight to the task search.
      if (!pick && loaded.length && (needsTask || document.activeElement === document.body)) focusField("task");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  useEffect(() => {
    if (task && !editing) savePrefs({ lastTaskId: task.id });
    if (!billableEdited) setBillable(task?.billable ?? project?.is_billable ?? true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  // MARK: Project picker

  const projectSections = useMemo<DropSection[]>(() => {
    const q = projectQuery.trim().toLowerCase();
    const item = (p: Project): DropItem => ({ id: p.id, title: p.name, detail: p.client?.name, dot: p.id });
    // Favourites first (project + task in one pick), only for new entries.
    const favs = editing ? [] : s.prefs.favorites.filter((f) =>
      !q || [f.name, f.projectName, f.taskName].some((t) => t.toLowerCase().includes(q)));
    const favSection: DropSection = {
      title: "Favourites",
      items: favs.map((f) => ({ id: FAV + f.id, title: f.name, detail: f.taskName, dot: f.projectId, star: true })),
    };
    if (!q) {
      const recent = s.recentProjects;
      const rest = s.projects.filter((p) => !recent.includes(p));
      return [favSection, { title: "Recent", items: recent.map(item) }, { title: "All projects", items: rest.map(item) }].filter((x) => x.items.length);
    }
    const hits = s.projects.filter((p) =>
      `${p.client?.name ?? ""} ${p.name}`.toLowerCase().includes(q) || (p.code ?? "").toLowerCase().includes(q));
    return [favSection, { title: favs.length ? "Projects" : undefined, items: hits.map(item) }].filter((x) => x.items.length);
  }, [projectQuery, s.projects, s.recent, s.prefs.favorites, editing]);
  const flatProjects = projectSections.flatMap((x) => x.items);

  /** A favourite: fill in project and task; the cursor goes to Notes. */
  const applyFavorite = (f: Favorite) => {
    const p = s.projects.find((x) => x.id === f.projectId) ?? { id: f.projectId, name: f.projectName };
    preferredTask.current = { id: f.taskId, name: f.taskName };
    setTask(null);
    setProjectQuery("");
    refs.project.current?.blur();
    setFocus(null);
    if (project?.id === p.id) {
      // Same project: the task effect won't rerun, so pick the task here.
      setTask(tasks.find((t) => t.id === f.taskId) ?? { id: f.taskId, name: f.taskName });
      preferredTask.current = null;
    } else {
      setProject(p);
    }
    projectChosen.current = true;
    setTicketReason(null);
    focusField("notes");
  };

  const pickProject = (it: DropItem) => {
    if (it.id.startsWith(FAV)) {
      const f = s.prefs.favorites.find((x) => FAV + x.id === it.id);
      if (f) applyFavorite(f);
      return;
    }
    const p = s.projects.find((x) => x.id === it.id);
    if (!p) return;
    projectChosen.current = true;
    setTicketReason(null);
    setProject(p);
    setProjectQuery("");
    refs.project.current?.blur();
    setFocus(null);
  };

  // MARK: Task picker

  const filteredTasks = useMemo(() => {
    const q = taskQuery.trim().toLowerCase();
    if (!q) return tasks;
    const words = q.split(/\s+/);
    const matches = tasks.filter((t) => words.every((w) => t.name.toLowerCase().includes(w)));
    const starts = matches.filter((t) => t.name.toLowerCase().startsWith(q));
    return [...starts, ...matches.filter((t) => !starts.includes(t))];
  }, [taskQuery, tasks]);

  const pickTask = (t: TaskItem) => {
    setTask(t);
    setTaskQuery("");
    setTaskHl(0);
    focusField("notes");
  };

  // MARK: Jira

  const jiraResults = [...jiraMine, ...jiraRecent, ...jiraOther];
  const jiraActive = focus === "jira" && !jiraIssue;

  const pickIssue = (issue: JiraIssue) => {
    setJiraIssue(issue);
    setJiraQuery("");
    // Empty notes (or notes still holding the previous ticket's title): use this ticket's title.
    const title = issue.summary.trim();
    const n = notes.trim();
    if (title && (!n || n === notesFromTicket)) {
      setNotes(title);
      setNotesFromTicket(title);
    }
    focusField("notes");
    void bookTicket(issue.key);
  };

  /**
   * The project (and task) the ticket books on: CSD → Service Desk with the ticket's customer as task;
   * other tickets follow where they (or their prefix) were logged before, unless you chose a project.
   */
  const bookTicket = async (key: string) => {
    const seq = ++ticketSeq.current;
    const sug = store.ticketSuggestion(key);
    if (!sug || (!sug.fixed && (projectChosen.current || editing))) {
      setTicketReason(null);
      return;
    }
    const chosenBefore = projectChosen.current;
    let t = sug.task ?? null;
    let fromJira = false;
    if (!t && sug.fixed) {
      const [orgs, loaded] = await Promise.all([store.ticketOrganizations(key), store.tasksFor(sug.project)]);
      t = taskForOrganization(orgs, loaded) ?? null;
      fromJira = !!t;
    }
    // A newer ticket, or you picked a project while the customer was looked up: leave it.
    if (seq !== ticketSeq.current || projectChosen.current !== chosenBefore) return;
    setTicketReason(fromJira && t ? `${sug.reason} · ${t.name}` : sug.reason);
    const { project: current, tasks: loadedTasks, task: currentTask } = latest.current;
    if (current?.id === sug.project.id) {
      // Same project: the task effect won't rerun. A project and task you chose yourself stay.
      if (chosenBefore && currentTask) return;
      if (t) setTask(loadedTasks.find((x) => x.id === t!.id) ?? t);
      else if (sug.fixed) {
        // The task was the last one used: probably another customer, so ask.
        setTask(null);
        focusField("task");
      }
      return;
    }
    preferredTask.current = t;
    ticketNeedsTask.current = sug.fixed && !t;
    setTask(null);
    setProject(sug.project);
  };

  const removeTicket = () => {
    if (notesFromTicket && notes.trim() === notesFromTicket) setNotes("");
    setNotesFromTicket(null);
    setJiraIssue(null);
    setTicketReason(null);
    ticketSeq.current++;
    focusField("jira");
  };

  // Your open tickets first (filtered locally, so "MOS" matches keys too), then a Jira search.
  useEffect(() => {
    if (!jiraActive || !s.hasJira) {
      setJiraMine([]);
      setJiraRecent([]);
      setJiraOther([]);
      return;
    }
    let cancelled = false;
    const q = jiraQuery.trim();
    const linked = keyFromLink(q);
    if (linked) {
      setJiraLoading(true);
      const mine = store.myJiraIssues.find((i) => i.key === linked);
      void (mine ? Promise.resolve(mine) : store.jira.issue(linked))
        .then((issue) => !cancelled && pickIssue(issue))
        .catch(() => !cancelled && setJiraQuery(linked))
        .finally(() => !cancelled && setJiraLoading(false));
      return () => {
        cancelled = true;
      };
    }
    const mine = () => {
      const all = store.myJiraIssues;
      if (!q) return all.slice(0, 8);
      const ql = q.toLowerCase();
      return all.filter((i) => i.key.toLowerCase().includes(ql) || i.summary.toLowerCase().includes(ql)).slice(0, 6);
    };
    const recent = () => {
      const mineKeys = new Set(mine().map((i) => i.key));
      const ql = q.toLowerCase();
      return store.recentTickets(q ? 20 : 6)
        .filter((i) => !mineKeys.has(i.key) && (!q || i.key.toLowerCase().includes(ql) || i.summary.toLowerCase().includes(ql)))
        .slice(0, q ? 4 : 6);
    };
    setJiraMine(mine());
    setJiraRecent(recent());
    setJiraOther([]);
    setJiraHl(0);
    if (!q) {
      void store.loadMyJiraIssues().then(() => {
        if (cancelled) return;
        setJiraMine(mine());
        setJiraRecent(recent());
      });
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setTimeout(async () => {
      setJiraLoading(true);
      try {
        const found = await store.jira.search(q);
        if (cancelled) return;
        const shown = new Set([...mine(), ...recent()].map((i) => i.key));
        setJiraOther(found.filter((i) => !shown.has(i.key)).slice(0, 8));
      } catch {
        // Search is a convenience; the user can keep typing.
      } finally {
        if (!cancelled) setJiraLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jiraActive, jiraQuery, s.hasJira]);

  // MARK: Timing

  const timing = useMemo((): { input: Timing | null; hint: string; ok?: boolean } => {
    if (editingRunning) return { input: { kind: "keep" }, hint: "Stop the timer to change its time" };
    const text = timeText.trim();
    if (!text) {
      if (editing) return { input: { kind: "keep" }, hint: "Empty keeps the current duration" };
      if (!isToday(date)) return { input: null, hint: "Timers run today. Enter a duration" };
      return { input: { kind: "timer" }, hint: "Leave empty to start a timer" };
    }
    const h = fmt.parseHours(text);
    if (h === null) return { input: null, hint: "Try 1:30, 1.5, 1h30 or 90m" };
    return { input: { kind: "duration", hours: h }, hint: `= ${fmt.words(h * 3600)}`, ok: true };
  }, [timeText, editingRunning, editing, date]);

  const startsTimer = timing.input?.kind === "timer";
  const invalidTime = !timing.input && !!timeText.trim();
  const submitTitle = editing ? "Save changes" : timing.input?.kind === "duration" ? `Save ${fmt.hoursLabel(timing.input.hours)}` : "Start timer";
  const notesMissing = s.requireNotes && !notes.trim();
  const canSubmit = !!project && !!task && !!timing.input && !submitting && editing?.is_locked !== true && !notesMissing;

  const submit = async () => {
    if (!canSubmit || !project || !task || !timing.input) return;
    setSubmitting(true);
    const t = timing.input;
    const ok = await store.submit({
      project, task, date, timing: t, billable, jira: jiraIssue, existingRef,
      notes: notes.trim(), editing, calendarEventId: event?.id,
    });
    setSubmitting(false);
    if (!ok) return;
    // Back to the day the entry landed on (timers always land on today).
    store.selectDay(t.kind === "timer" ? new Date() : date);
    nav.set(event ? "calendar" : "day");
  };

  const doDelete = async () => {
    if (!editing) return;
    setSubmitting(true);
    const ok = await store.deleteEntry(editing);
    setSubmitting(false);
    setConfirmDelete(false);
    if (ok) nav.set("day");
  };

  const shiftDate = (n: number) => {
    const d = addDays(date, n);
    setDate(d > new Date() ? startOfDay(new Date()) : d);
  };

  // Ctrl+Enter saves from anywhere in the form.
  const onFormKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      void submit();
    }
  };

  // Arrow keys / Enter in a dropdown field.
  const listKeys = (n: number, hl: number, setHl: (n: number) => void, pick: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" && n) { e.preventDefault(); setHl((hl + 1) % n); }
    else if (e.key === "ArrowUp" && n) { e.preventDefault(); setHl((hl - 1 + n) % n); }
    else if (e.key === "Enter" && !e.ctrlKey) { e.preventDefault(); pick(); }
  };

  return (
    <div className="panel" onKeyDown={onFormKey}>
      <div className="panel-header">
        <IconButton label="Back" onClick={() => nav.back()}><ChevronLeft /></IconButton>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span className="panel-title">{editing ? "Edit entry" : "New entry"}</span>
          <span className="panel-sub row" style={{ gap: 5 }}>
            {event && <><CalendarIcon size={10} /> From calendar ·</>} {shortDay(date)}
          </span>
        </div>
        <span className="grow" />
        {(() => {
          const fav = project && task ? s.favoriteFor(project.id, task.id) : undefined;
          return (
            <IconButton
              label={fav ? "Remove from favourites" : "Save as favourite"}
              disabled={!project || !task}
              onClick={() => project && task && s.toggleFavorite(project, task)}
            >
              <Star size={14} filled={!!fav} className={fav ? "star-on" : undefined} />
            </IconButton>
          );
        })()}
        <IconButton label="Close" onClick={() => nav.set("collapsed")}><Close /></IconButton>
      </div>

      <div className="panel-body" style={{ overflowY: focus === "project" || focus === "task" || focus === "jira" ? "visible" : "auto" }}>
        <div className="form">
          <FieldBox
            title="Jira ticket"
            trailing={!s.hasJira ? "Set up Jira in Settings" : jiraIssue && ticketReason ? ticketReason : "Optional · links the entry"}
            z={5}
          >
            {jiraIssue ? (
              <div className="ticket-box">
                <TicketChip ticketKey={jiraIssue.key} url={s.ticketUrl(jiraIssue.key, existingRef?.id === jiraIssue.key ? existingRef.permalink : null)} />
                <span className="ellipsis grow" style={{ fontSize: 12.5 }}>{jiraIssue.summary}</span>
                <IconButton label={`Remove ticket ${jiraIssue.key}`} onClick={removeTicket}><Close size={10} /></IconButton>
              </div>
            ) : (
              <div className="input">
                <input
                  ref={refs.jira}
                  value={jiraQuery}
                  placeholder="Pick one of yours, or search key or title"
                  aria-label="Jira ticket"
                  disabled={!s.hasJira}
                  onFocus={() => { setFocus("jira"); store.prepareTicketHistory(); }}
                  onBlur={() => setFocus(null)}
                  onChange={(e) => setJiraQuery(e.target.value)}
                  onKeyDown={listKeys(jiraResults.length, jiraHl, setJiraHl, () =>
                    jiraResults[jiraHl] ? pickIssue(jiraResults[jiraHl]) : focusField("notes"))}
                />
                {jiraLoading && <Spinner />}
              </div>
            )}
            {jiraActive && jiraResults.length > 0 && (
              <Dropdown
                sections={[
                  { title: "Assigned to me", items: jiraMine.map(issueItem) },
                  { title: "Recently logged", items: jiraRecent.map(issueItem) },
                  { title: jiraMine.length || jiraRecent.length ? "Other matches" : undefined, items: jiraOther.map(issueItem) },
                ].filter((x) => x.items.length)}
                highlight={jiraHl}
                onPick={(it) => { const i = jiraResults.find((x) => x.key === it.id); if (i) pickIssue(i); }}
              />
            )}
          </FieldBox>

          <FieldBox title="Project" trailing={project?.client?.name ?? "Recent first"} z={4}>
            <div className="input">
              {project && focus !== "project" && <ProjectDot id={project.id} />}
              <input
                ref={refs.project}
                value={focus === "project" ? projectQuery : project?.name ?? projectQuery}
                placeholder="Type to search projects"
                aria-label="Project"
                onFocus={() => { setFocus("project"); setProjectHl(0); }}
                onBlur={() => { setFocus(null); setProjectQuery(""); }}
                onChange={(e) => { setProjectQuery(e.target.value); setProjectHl(0); }}
                onKeyDown={listKeys(flatProjects.length, projectHl, setProjectHl, () => flatProjects[projectHl] && pickProject(flatProjects[projectHl]))}
              />
            </div>
            {focus === "project" && <Dropdown sections={projectSections} highlight={projectHl} onPick={pickProject} />}
          </FieldBox>

          <FieldBox title="Task" trailing={tasks.length > 1 ? `Type to search · 1–${Math.min(9, tasks.length)} to pick` : undefined} z={3}>
            <div className="input" onClick={() => refs.task.current?.focus()}>
              {tasksLoading && <Spinner />}
              <input
                ref={refs.task}
                value={focus === "task" ? taskQuery : task?.name ?? ""}
                placeholder={!project ? "Pick a project first" : tasksLoading ? "Loading tasks…" : "Search tasks"}
                aria-label="Task"
                disabled={!project || !tasks.length}
                onFocus={() => { setFocus("task"); setTaskHl(Math.max(0, task ? tasks.findIndex((t) => t.id === task.id) : 0)); }}
                onBlur={() => { setFocus(null); setTaskQuery(""); }}
                onChange={(e) => {
                  const v = e.target.value;
                  // Empty field: a digit is the "1–9 to pick" shortcut, not a search.
                  if (!taskQuery && /^[1-9]$/.test(v) && tasks[+v - 1]) { pickTask(tasks[+v - 1]); return; }
                  setTaskQuery(v);
                  setTaskHl(0);
                }}
                onKeyDown={listKeys(filteredTasks.length, taskHl, setTaskHl, () => filteredTasks[taskHl] && pickTask(filteredTasks[taskHl]))}
              />
              <ChevronDown size={11} className="muted" />
            </div>
            {focus === "task" && (
              filteredTasks.length ? (
                <Dropdown
                  sections={[{ items: filteredTasks.map((t) => {
                    const n = tasks.indexOf(t) + 1;
                    return { id: t.id, title: t.name, detail: !taskQuery && n <= 9 ? String(n) : undefined };
                  }) }]}
                  highlight={taskHl}
                  onPick={(it) => { const t = tasks.find((x) => x.id === it.id); if (t) pickTask(t); }}
                />
              ) : taskQuery ? (
                <div className="dropdown muted" style={{ padding: "8px 10px" }}>No task matches “{taskQuery}”</div>
              ) : null
            )}
          </FieldBox>

          <FieldBox title="Notes" trailing={s.requireNotes ? "Required" : undefined}>
            <textarea
              ref={refs.notes}
              className="input-area"
              value={notes}
              placeholder="What did you work on?"
              aria-label="Notes"
              onFocus={() => setFocus("notes")}
              onBlur={() => setFocus(null)}
              onChange={(e) => setNotes(e.target.value)}
            />
          </FieldBox>

          <div className="row" style={{ alignItems: "flex-start", gap: 10 }}>
            <div className="grow">
              <FieldBox title={editingRunning ? "Duration · running" : "Duration"}>
                <div className={`input ${invalidTime ? "invalid" : ""}`}>
                  <input
                    ref={refs.time}
                    className="num"
                    value={timeText}
                    placeholder={editingRunning ? "Timer running" : "0:00"}
                    aria-label="Duration"
                    disabled={editingRunning}
                    onFocus={() => setFocus("time")}
                    onBlur={() => setFocus(null)}
                    onChange={(e) => setTimeText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.ctrlKey) { e.preventDefault(); void submit(); } }}
                  />
                </div>
                <span className={`hint ${timing.ok ? "ok" : invalidTime ? "bad" : ""}`}>{timing.ok ? "✓ " : invalidTime ? "⚠ " : ""}{timing.hint}</span>
              </FieldBox>
            </div>
            <div style={{ width: 132 }}>
              <FieldBox title="Date">
                <div className="input" style={{ padding: "0 4px", justifyContent: "space-between" }}>
                  <IconButton label="Earlier" onClick={() => shiftDate(-1)}><ChevronLeft size={12} /></IconButton>
                  <span style={{ fontSize: 12.5 }}>{isToday(date) ? "Today" : date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
                  <IconButton label="Later" onClick={() => shiftDate(1)} disabled={isToday(date)}><ChevronRight size={12} /></IconButton>
                </div>
              </FieldBox>
            </div>
          </div>

          {s.canOverrideBillable && (
            <label className="row" style={{ cursor: "pointer" }}>
              <div className="grow">
                <div>Billable</div>
                <div className="muted" style={{ fontSize: 11.5 }}>{billable === defaultBillable ? "Default for this task" : "Overrides the task default"}</div>
              </div>
              <span className="switch">
                <input type="checkbox" checked={billable} onChange={(e) => { setBillable(e.target.checked); setBillableEdited(true); }} />
                <span />
              </span>
            </label>
          )}
        </div>
      </div>

      <div className="panel-footer">
        {s.lastError && <div className="error">{s.lastError}</div>}
        {confirmDelete && editing ? (
          <div className="row">
            <b className="grow">Delete this entry?</b>
            <button className="pill ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button className="pill danger" disabled={submitting} onClick={() => void doDelete()}>
              {submitting ? <Spinner /> : <Trash size={12} />} Delete
            </button>
          </div>
        ) : (
          <div className="row">
            {editing && (
              <button
                className="pill outline"
                style={{ width: 34, padding: 0, color: "var(--danger-text)" }}
                disabled={editing.is_locked === true || submitting}
                title={editing.is_locked ? "Approved or invoiced entries can't be deleted" : "Delete entry"}
                aria-label="Delete entry"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash size={13} />
              </button>
            )}
            <button className="pill ghost" onClick={() => nav.back()}>Cancel</button>
            <button className={`pill grow ${startsTimer ? "live" : "primary"}`} disabled={!canSubmit} onClick={() => void submit()}>
              {submitting ? <Spinner /> : startsTimer ? <Play size={10} /> : null}
              {submitTitle} <Kbd>Ctrl+↵</Kbd>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const issueItem = (i: JiraIssue): DropItem => ({ id: i.key, title: i.summary, detail: i.status, ticket: i.key });

function FieldBox({ title, trailing, z, children }: { title: string; trailing?: string; z?: number; children: ReactNode }) {
  return (
    <div className="field" style={{ zIndex: z }}>
      <div className="field-label"><span>{title}</span>{trailing && <span title={trailing}>{trailing}</span>}</div>
      {children}
    </div>
  );
}

function Dropdown({ sections, highlight, onPick }: { sections: DropSection[]; highlight: number; onPick: (it: DropItem) => void }) {
  const hlRef = useRef<HTMLDivElement>(null);
  useEffect(() => hlRef.current?.scrollIntoView({ block: "nearest" }), [highlight]);
  let i = -1;
  return (
    // mousedown, not click: picking must happen before the input loses focus (which closes the list).
    <div className="dropdown" role="listbox" onMouseDown={(e) => e.preventDefault()}>
      {sections.map((sec, si) => (
        <div key={si}>
          {sec.title && <div className="section">{sec.title}</div>}
          {sec.items.map((it) => {
            i++;
            const hl = i === highlight;
            return (
              <div
                key={it.id}
                ref={hl ? hlRef : undefined}
                className={`item ${hl ? "hl" : ""}`}
                role="option"
                aria-selected={hl}
                onMouseDown={() => onPick(it)}
              >
                {it.star ? <Star size={11} filled className="star-on" /> : it.dot && <ProjectDot id={it.dot} />}
                {it.ticket && <span className="chip">{it.ticket}</span>}
                <span className="ellipsis">{it.title}</span>
                {it.detail && <span className="detail">{it.detail}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
