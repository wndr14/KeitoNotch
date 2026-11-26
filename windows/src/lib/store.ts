// App state for the notch window — port of AppState.swift (minus Apple Calendar, favourites,
// alternating weeks and own hours per day, which the Windows MVP leaves out).
import { useSyncExternalStore } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { KeitoClient, friendlyError } from "./keito";
import { JiraClient } from "./jira";
import { CalendarProblem, GoogleAuth, GoogleCalendarClient, NotSignedIn, dedupeKey } from "./google";
import { matchEvent, type Match } from "./matcher";
import { recentTicketsOf, suggestForTicket, type TicketSuggestion } from "./ticketRules";
import { idleStep } from "./idle";
import { native } from "./native";
import { hasGoogleClient, hasJira, hasKeito, loadCredentials, loadPrefs, savePrefs, type Credentials, type Favorite, type Prefs } from "./prefs";
import * as targets from "./targets";
import { addDays, dayKey, isSameDay, startOfDay, startOfWeek, weekNumber, weekStartDay } from "./dates";
import * as fmt from "./duration";
import {
  calendarEventIdOf,
  projectIdOf,
  taskIdOf,
  type CalendarEvent,
  type CalendarInfo,
  type CurrentUser,
  type ExternalReference,
  type JiraIssue,
  type NewTimeEntry,
  type Project,
  type TaskItem,
  type TimeEntry,
  type TimeEntryUpdate,
} from "./models";

export interface IdleSpan {
  start: Date;
  end: Date;
}

export type Timing = { kind: "duration"; hours: number } | { kind: "timer" } | { kind: "keep" };

export interface EntryInput {
  project: Project;
  task: TaskItem;
  date: Date;
  timing: Timing;
  billable: boolean;
  jira: JiraIssue | null;
  existingRef: ExternalReference | null;
  notes: string;
  editing: TimeEntry | null;
  calendarEventId?: string;
}

/** Message for the toast window. */
export interface ToastMessage {
  id: number;
  message: string;
  /** Has an action button (Undo, or `actionLabel`). */
  undo: boolean;
  actionLabel?: string;
}

const EMPTY_CREDS: Credentials = {
  keitoAccountId: "", keitoApiKey: "", jiraHost: "", jiraEmail: "", jiraToken: "", googleClientId: "", googleClientSecret: "",
};

/** How long a day's calendar events are reused before loading them again. */
const CALENDAR_FRESH_MS = 5 * 60_000;

export class AppStore {
  // Data
  creds: Credentials = EMPTY_CREDS;
  prefs: Prefs = loadPrefs();
  user: CurrentUser | null = null;
  running: TimeEntry | null = null;
  recent: TimeEntry[] = [];
  today: TimeEntry[] = [];
  projects: Project[] = [];
  myJiraIssues: JiraIssue[] = [];
  lastError: string | null = null;
  isBusy = false;
  loaded = false;

  // Day view
  selectedDay = startOfDay(new Date());
  weekEntries: TimeEntry[] = [];
  weekLoading = false;

  // Google Calendar
  googleSignedIn = false;
  googleConnecting = false;
  calendarEvents: Record<string, CalendarEvent[]> = {};
  calendarLoading = false;
  calendarList: CalendarInfo[] = [];
  calendarError: CalendarProblem | null = null;
  /** When each day's events were last loaded without errors; a failed load is never cached. */
  private calendarLoadedAt: Record<string, number> = {};
  private matchHistory: TimeEntry[] = [];
  private historyLoadedAt = 0;
  private googleAuthStore: GoogleAuth | null = null;

  // Idle
  idlePrompt: IdleSpan | null = null;
  private idleSince: Date | null = null;
  onIdleReturn?: () => void;

  // Live clock
  now = Date.now();
  private runningFetchedAt = Date.now();
  private runningSecondsAtFetch = 0;
  private lastRunSample: { key: string; saved: number; at: number } | null = null;
  private savedIncludesRun = false;

  private taskCache = new Map<string, TaskItem[]>();
  private tickTimer?: number;
  private pollTimer?: number;
  private toastSeq = 0;
  private toastUndo = new Map<number, () => Promise<void>>();
  private lastTooltip = "";

  // MARK: Subscription (React)

  private version = 0;
  private listeners = new Set<() => void>();
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  notify() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  get keito() {
    return new KeitoClient(this.creds);
  }
  get jira() {
    return new JiraClient(this.creds);
  }
  get hasJira() {
    return hasJira(this.creds);
  }

  get elapsed(): number {
    if (!this.running) return 0;
    return this.runningSecondsAtFetch + (this.now - this.runningFetchedAt) / 1000;
  }

  get canOverrideBillable(): boolean {
    return this.user?.company?.time_billability_overrides_enabled !== false && this.user?.capabilities?.can_edit_time_billability === true;
  }

  get requireNotes(): boolean {
    return this.user?.company?.require_notes === true;
  }

  /** Projects of your latest entries, most recent first (max 3). */
  get recentProjects(): Project[] {
    const seen = new Set<string>();
    const out: Project[] = [];
    for (const e of this.recent) {
      const id = projectIdOf(e);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const p = this.projects.find((x) => x.id === id);
      if (p) out.push(p);
      if (out.length === 3) break;
    }
    return out;
  }

  projectFor(e: TimeEntry): Project | undefined {
    const id = projectIdOf(e);
    return id ? this.projects.find((p) => p.id === id) : undefined;
  }

  projectName(e: TimeEntry): string {
    return e.project?.name ?? this.projectFor(e)?.name ?? "Project";
  }

  clientName(e: TimeEntry): string | undefined {
    return (e.client?.name ?? this.projectFor(e)?.client?.name) || undefined;
  }

  ticketUrl(key: string, permalink?: string | null): string | undefined {
    if (permalink && /^https?:/.test(permalink)) return permalink;
    return this.hasJira ? this.jira.browseUrl(key) : undefined;
  }

  // MARK: Targets (see targets.ts)

  isWorkday(d: Date) {
    return targets.isWorkday(this.prefs, d);
  }

  /** Keito weekly capacity spread over your average work days; 8 h without a capacity. */
  get dailyTargetSeconds(): number {
    return targets.dailyTargetSeconds(this.prefs, this.user?.weekly_capacity);
  }

  target(d: Date) {
    return targets.targetOn(this.prefs, this.user?.weekly_capacity, d);
  }

  get weeklyTargetSeconds() {
    return this.weekDays.reduce((s, d) => s + this.target(d), 0);
  }

  // MARK: Favourites

  favoriteFor(projectId: string, taskId: string): Favorite | undefined {
    return this.prefs.favorites.find((f) => f.projectId === projectId && f.taskId === taskId);
  }

  private setFavorites(favorites: Favorite[]) {
    this.prefs = savePrefs({ favorites });
    this.notify();
  }

  /** Saves the project + task as a favourite, or removes it when it already is one. */
  toggleFavorite(project: { id: string; name: string }, task: { id: string; name: string }) {
    const existing = this.favoriteFor(project.id, task.id);
    if (existing) {
      this.setFavorites(this.prefs.favorites.filter((f) => f.id !== existing.id));
      this.showToast(`Removed “${existing.name}” from favourites`);
      return;
    }
    const name = `${project.name} · ${task.name}`;
    this.setFavorites([...this.prefs.favorites, {
      id: crypto.randomUUID(), name, projectId: project.id, projectName: project.name, taskId: task.id, taskName: task.name,
    }]);
    this.showToast(`Saved “${name}” as a favourite`);
  }

  /** From a logged entry (day-list menu). */
  addFavorite(entry: TimeEntry) {
    const p = projectIdOf(entry);
    const t = taskIdOf(entry);
    if (!p || !t) return;
    if (this.favoriteFor(p, t)) {
      this.showToast("Already a favourite");
      return;
    }
    this.toggleFavorite({ id: p, name: this.projectName(entry) }, { id: t, name: entry.task?.name ?? "Task" });
  }

  // MARK: Week

  get weekStart() {
    return startOfWeek(this.selectedDay, weekStartDay(this.user?.company?.week_start_day));
  }

  get weekDays(): Date[] {
    const s = this.weekStart;
    return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(s, i));
  }

  get weekNumber() {
    return weekNumber(this.selectedDay);
  }

  entriesOn(d: Date): TimeEntry[] {
    const key = dayKey(d);
    if (key === dayKey(new Date())) return this.today;
    return this.weekEntries.filter((e) => e.spent_date === key);
  }

  secondsOn(d: Date): number {
    const key = dayKey(d);
    const list = key === dayKey(new Date()) ? this.today : this.weekEntries;
    const done = list
      .filter((e) => e.spent_date === key && e.id !== this.running?.id)
      .reduce((s, e) => s + (e.hours ?? 0) * 3600, 0);
    return done + (this.running?.spent_date === key ? this.elapsed : 0);
  }

  get todaySeconds() {
    return this.secondsOn(new Date());
  }

  get weekSeconds() {
    return this.weekDays.reduce((s, d) => s + this.secondsOn(d), 0);
  }

  selectDay(d: Date) {
    const day = startOfDay(d);
    const first = weekStartDay(this.user?.company?.week_start_day);
    const weekChanged = !isSameDay(startOfWeek(day, first), this.weekStart);
    this.selectedDay = day;
    if (weekChanged) {
      this.weekEntries = [];
      void this.loadWeek();
    }
    this.notify();
  }

  shiftDay(n: number) {
    this.selectDay(addDays(this.selectedDay, n));
  }

  async loadWeek() {
    if (!hasKeito(this.creds)) return;
    const start = this.weekStart;
    const days = this.weekDays;
    this.weekLoading = true;
    this.notify();
    try {
      const entries = await this.keito.entries(this.user?.id, dayKey(start), dayKey(days[6]), true);
      if (isSameDay(start, this.weekStart)) this.weekEntries = entries; // else the user moved on
    } catch (e) {
      this.lastError = friendlyError(e);
    } finally {
      this.weekLoading = false;
      this.notify();
    }
  }

  // MARK: Lifecycle

  private undoListener: Promise<unknown> | null = null;

  /** Safe to call again (the notch restarts its UI after a crash): one Undo listener, a fresh load. */
  async start() {
    this.undoListener ??= listen<number>("toast-undo", (ev) => void this.runUndo(ev.payload));
    await this.undoListener;
    await this.reload();
  }

  /** (Re)loads credentials and data — on start and after Settings changes. */
  async reload() {
    window.clearInterval(this.tickTimer);
    window.clearInterval(this.pollTimer);
    this.creds = await loadCredentials();
    this.prefs = loadPrefs();
    this.googleAuthStore = null;
    this.user = null;
    this.projects = [];
    this.taskCache.clear();
    this.clearCalendarCache();
    this.notify();

    this.tickTimer = window.setInterval(() => {
      this.now = Date.now();
      this.updateTooltip();
      void this.checkIdle();
      this.notify();
    }, 1000);
    this.pollTimer = window.setInterval(() => void this.refreshRunning(), 30_000);
    await this.bootstrap();
  }

  /** Preferences changed in another window (no credential change). */
  reloadPrefs() {
    const before = this.prefs;
    this.prefs = loadPrefs();
    // Other calendars chosen (or the calendar switched off/on): what was loaded no longer applies.
    if (
      before.calendarEnabled !== this.prefs.calendarEnabled ||
      JSON.stringify(before.googleCalendarIds) !== JSON.stringify(this.prefs.googleCalendarIds)
    ) {
      this.clearCalendarCache();
    }
    this.notify();
  }

  private clearCalendarCache() {
    this.calendarEvents = {};
    this.calendarLoadedAt = {};
  }

  private async bootstrap() {
    await this.refreshGoogleStatus();
    void this.loadCalendarList();
    if (!hasKeito(this.creds)) {
      this.lastError = "Add your Keito API key in Settings.";
      this.loaded = true;
      this.notify();
      return;
    }
    try {
      this.user = await this.keito.me();
      const projects = this.keito.trackableProjects();
      await this.refreshRunning();
      this.projects = await projects;
      this.lastError = null;
      void this.loadMyJiraIssues();
    } catch (e) {
      this.lastError = friendlyError(e);
    } finally {
      this.loaded = true;
      this.notify();
    }
  }

  async refreshRunning() {
    if (!hasKeito(this.creds)) return;
    try {
      this.setRunning(await this.keito.runningEntry(this.user?.id));
      const todayKey = dayKey(new Date());
      const [recent, today] = await Promise.allSettled([
        this.keito.recentEntries(this.user?.id),
        this.keito.entries(this.user?.id, todayKey, todayKey, true),
      ]);
      if (recent.status === "fulfilled") this.recent = recent.value;
      if (today.status === "fulfilled") this.today = today.value;
      this.lastError = null;
      this.notify();
      await this.loadWeek();
    } catch (e) {
      this.lastError = friendlyError(e);
      this.notify();
    }
  }

  private setRunning(entry: TimeEntry | null) {
    this.running = entry;
    this.runningFetchedAt = Date.now();
    this.now = this.runningFetchedAt;
    if (!entry) {
      this.runningSecondsAtFetch = 0;
      this.idleSince = null;
      return;
    }
    // Keito stores the time saved before the current run; live time = saved + time since timer_started_at.
    const saved = entry.duration_seconds ?? (entry.hours ?? 0) * 3600;
    // If the saved value itself grows between refreshes of the same run, Keito already counts the live time.
    const runKey = `${entry.id}|${entry.timer_started_at ?? ""}`;
    const last = this.lastRunSample;
    if (last && last.key === runKey && saved - last.saved > 15 && (this.runningFetchedAt - last.at) / 1000 > 15) {
      this.savedIncludesRun = true;
    } else if (last?.key !== runKey) {
      this.savedIncludesRun = false;
    }
    this.lastRunSample = { key: runKey, saved, at: this.runningFetchedAt };
    const started = entry.timer_started_at ? Date.parse(entry.timer_started_at) : NaN;
    this.runningSecondsAtFetch = !this.savedIncludesRun && !isNaN(started)
      ? saved + Math.max(0, (this.runningFetchedAt - started) / 1000)
      : saved;
  }

  private updateTooltip() {
    const r = this.running;
    const text = r ? `Keito Notch · ${fmt.short(this.elapsed)} · ${this.projectName(r)}` : `Keito Notch · today ${fmt.short(this.todaySeconds)}`;
    // Tray tooltips only change once a minute; skip redundant IPC.
    if (text !== this.lastTooltip) {
      this.lastTooltip = text;
      native.setTrayTooltip(text).catch(() => undefined);
    }
  }

  async loadMyJiraIssues() {
    if (!this.hasJira) {
      this.myJiraIssues = [];
      return;
    }
    try {
      this.myJiraIssues = await this.jira.myOpenIssues();
      this.notify();
    } catch {
      // Ticket suggestions are optional.
    }
  }

  async tasksFor(p: Project): Promise<TaskItem[]> {
    if (p.tasks) return p.tasks;
    const cached = this.taskCache.get(p.id);
    if (cached) return cached;
    try {
      const t = await this.keito.tasks(p.id);
      this.taskCache.set(p.id, t);
      return t;
    } catch (e) {
      this.lastError = friendlyError(e);
      this.notify();
      return [];
    }
  }

  // MARK: Timer actions (each offers Undo)

  async stopRunning() {
    const r = this.running;
    if (!r) return;
    const label = `${this.projectName(r)} at ${fmt.short(this.elapsed)}`;
    if (!(await this.perform(() => this.keito.stop(r.id)))) return;
    this.showToast(`Stopped ${label}`, async () => {
      await this.perform(() => this.keito.restart(r.id));
    });
  }

  /** Continues the same row (entries dated today). */
  async resume(entry: TimeEntry) {
    const prev = this.running;
    const prevLabel = prev ? `${this.projectName(prev)} (${fmt.short(this.elapsed)})` : null;
    if (!(await this.perform(() => this.keito.restart(entry.id)))) return;
    this.showToast(prevLabel ? `Switched from ${prevLabel}` : `Started ${this.projectName(entry)}`, async () => {
      await this.perform(async () => {
        await this.keito.stop(entry.id);
        if (prev) await this.keito.restart(prev.id);
      });
    });
  }

  /** New running entry for today with the same project, task, notes, billability and ticket. */
  async continueToday(entry: TimeEntry) {
    const projectId = projectIdOf(entry);
    const taskId = taskIdOf(entry);
    if (!projectId || !taskId) {
      this.lastError = "That entry has no project or task to copy.";
      this.notify();
      return;
    }
    await this.createWithUndo({
      project_id: projectId,
      task_id: taskId,
      spent_date: dayKey(new Date()),
      is_running: true,
      replace_running: true,
      billable: this.canOverrideBillable ? entry.billable ?? undefined : undefined,
      notes: entry.notes ?? undefined,
      external_reference: entry.external_reference ?? undefined,
      source: "desktop",
    }, `Started ${this.projectName(entry)} today`);
    this.selectDay(new Date());
  }

  // MARK: Form

  async submit(input: EntryInput): Promise<boolean> {
    const ref: ExternalReference | null = input.jira
      ? input.existingRef?.id === input.jira.key
        ? input.existingRef
        : {
            id: input.jira.key,
            permalink: this.jira.browseUrl(input.jira.key),
            service: this.creds.jiraHost,
            service_name: "Jira",
            display_name: `${input.jira.key} ${input.jira.summary}`.trim(),
          }
      : null;
    const notes = input.notes || null;
    const billable = this.canOverrideBillable ? input.billable : undefined;
    const name = input.project.name;

    if (input.editing) {
      const u: TimeEntryUpdate = {
        project_id: input.project.id,
        task_id: input.task.id,
        spent_date: dayKey(input.date),
        billable,
        notes,
        external_reference: ref,
      };
      if (input.timing.kind === "duration") u.hours = input.timing.hours;
      const id = input.editing.id;
      const ok = await this.perform(() => this.keito.update(id, u));
      if (ok) this.showToast("Entry updated");
      return ok;
    }

    const entry: NewTimeEntry = {
      project_id: input.project.id,
      task_id: input.task.id,
      spent_date: dayKey(input.date),
      billable,
      notes: notes ?? undefined,
      external_reference: ref ?? undefined,
      metadata: input.calendarEventId ? { calendar_event_id: input.calendarEventId } : undefined,
      source: "desktop",
    };
    let message: string;
    if (input.timing.kind === "duration") {
      entry.hours = input.timing.hours;
      message = `Logged ${fmt.words(input.timing.hours * 3600)} on ${name}${ref ? ` · ${ref.id}` : ""}`;
    } else if (input.timing.kind === "timer") {
      entry.is_running = true;
      entry.replace_running = true;
      message = this.running ? `Timer started. Stopped ${this.projectName(this.running)}` : "Timer started";
    } else {
      return false;
    }
    return this.createWithUndo(entry, message);
  }

  /** Deletes an entry; Undo recreates it. */
  async deleteEntry(entry: TimeEntry): Promise<boolean> {
    const hours = entry.id === this.running?.id ? this.elapsed / 3600 : entry.hours ?? 0;
    const name = this.projectName(entry);
    if (!(await this.perform(() => this.keito.delete(entry.id)))) return false;
    const projectId = projectIdOf(entry);
    const taskId = taskIdOf(entry);
    if (projectId && taskId && entry.spent_date) {
      const copy: NewTimeEntry = {
        project_id: projectId,
        task_id: taskId,
        spent_date: entry.spent_date,
        hours: Math.max(0.01, Math.round(hours * 100) / 100),
        billable: this.canOverrideBillable ? entry.billable ?? undefined : undefined,
        notes: entry.notes ?? undefined,
        external_reference: entry.external_reference ?? undefined,
        source: "desktop",
      };
      this.showToast(`Deleted ${name} · ${fmt.hoursLabel(hours)}`, async () => {
        await this.perform(async () => {
          await this.keito.create(copy);
        });
      });
    } else {
      this.showToast(`Deleted ${name}`);
    }
    return true;
  }

  /** Creates an entry; Undo deletes it and resumes whatever ran before. */
  private async createWithUndo(entry: NewTimeEntry, message: string): Promise<boolean> {
    const prev = entry.is_running ? this.running : null;
    let created: TimeEntry | null = null;
    const ok = await this.perform(async () => {
      created = await this.keito.create(entry);
    });
    if (!ok || !created) return ok;
    const id = (created as TimeEntry).id;
    this.showToast(message, async () => {
      await this.perform(async () => {
        await this.keito.delete(id);
        if (prev) await this.keito.restart(prev.id);
      });
    });
    return true;
  }

  // MARK: Google Calendar

  get calendarConnected() {
    return this.prefs.calendarEnabled && this.googleSignedIn;
  }

  get googleAuth(): GoogleAuth | null {
    if (!hasGoogleClient(this.creds)) return null;
    this.googleAuthStore ??= new GoogleAuth(this.creds.googleClientId, this.creds.googleClientSecret);
    return this.googleAuthStore;
  }

  async refreshGoogleStatus() {
    this.googleSignedIn = (await this.googleAuth?.isSignedIn()) ?? false;
    this.notify();
  }

  async connectGoogle() {
    const auth = this.googleAuth;
    if (!auth) {
      this.calendarError = new CalendarProblem("Google Calendar", "Add a Google OAuth client ID and secret in Settings.");
      this.notify();
      return;
    }
    this.googleConnecting = true;
    this.notify();
    try {
      await auth.signIn();
      this.calendarError = null;
      this.prefs = savePrefs({ calendarEnabled: true });
      await this.refreshGoogleStatus();
      await this.loadCalendarList();
      await this.loadCalendar(this.selectedDay, true);
    } catch (e) {
      this.calendarError = CalendarProblem.from(e);
    } finally {
      this.googleConnecting = false;
      this.notify();
    }
  }

  async loadCalendarList() {
    const auth = this.googleAuth;
    if (!this.calendarConnected || !auth) {
      this.calendarList = [];
      return;
    }
    try {
      this.calendarList = await new GoogleCalendarClient(auth).calendars();
    } catch (e) {
      this.calendarError = CalendarProblem.from(e);
    }
    this.notify();
  }

  /** Calendars actually read: your choice, else the primary one. */
  private get selectedCalendarIds(): string[] {
    return this.prefs.googleCalendarIds ?? this.calendarList.filter((c) => c.isPrimary).map((c) => c.id);
  }

  eventsOn(d: Date): CalendarEvent[] {
    return this.calendarEvents[dayKey(d)] ?? [];
  }

  async loadCalendar(day: Date, force = false) {
    const auth = this.googleAuth;
    if (!this.calendarConnected || !auth) return;
    const key = dayKey(day);
    // Reuse a good load for a few minutes; a meeting planned meanwhile shows up after that.
    const loadedAt = this.calendarLoadedAt[key];
    if (!force && loadedAt !== undefined && Date.now() - loadedAt < CALENDAR_FRESH_MS) return;
    this.calendarLoading = true;
    this.notify();
    const history = this.loadMatchHistory();
    const start = startOfDay(day);
    const end = addDays(start, 1);
    const client = new GoogleCalendarClient(auth);
    if (!this.calendarList.length) await this.loadCalendarList();
    let ids = this.selectedCalendarIds;
    if (!ids.length && this.prefs.googleCalendarIds === null) ids = ["primary"];
    let merged: CalendarEvent[] = [];
    let problem: CalendarProblem | null = null;
    for (const id of [...ids].sort()) {
      try {
        merged = merged.concat(await client.events(id, start, end));
      } catch (e) {
        problem = CalendarProblem.from(e);
        if (e instanceof NotSignedIn) {
          await this.refreshGoogleStatus();
          break;
        }
      }
    }
    const seen = new Set<string>();
    this.calendarEvents = {
      ...this.calendarEvents,
      [key]: merged.filter((e) => !seen.has(dedupeKey(e)) && !!seen.add(dedupeKey(e))).sort((a, b) => +a.start - +b.start),
    };
    if (problem) delete this.calendarLoadedAt[key];
    else this.calendarLoadedAt[key] = Date.now();
    this.calendarError = problem;
    this.calendarLoading = false;
    this.notify();
    await history;
  }

  private async loadMatchHistory() {
    if (Date.now() - this.historyLoadedAt < 3600_000) return;
    try {
      const entries = await this.keito.entries(this.user?.id, dayKey(addDays(new Date(), -90)), dayKey(new Date()));
      this.matchHistory = entries.sort((a, b) => (b.spent_date ?? "").localeCompare(a.spent_date ?? ""));
      this.historyLoadedAt = Date.now();
      this.notify();
    } catch {
      // Matching just gets less clever.
    }
  }

  loggedEntry(ev: CalendarEvent): TimeEntry | undefined {
    return [...this.today, ...this.weekEntries, ...this.matchHistory].find((e) => calendarEventIdOf(e) === ev.id);
  }

  match(ev: CalendarEvent): Match {
    return matchEvent(ev, this.projects, [...this.today, ...this.recent, ...this.matchHistory]);
  }

  // MARK: Jira tickets → project

  /** Loads the last 90 days of entries (at most hourly), so a ticket can follow where it was logged before. */
  prepareTicketHistory() {
    void this.loadMatchHistory();
  }

  /** All loaded entries, newest first, each once. */
  private ticketHistory(): TimeEntry[] {
    const seen = new Set<string>();
    return [...this.today, ...this.weekEntries, ...this.recent, ...this.matchHistory]
      .filter((e) => !seen.has(e.id) && !!seen.add(e.id))
      .sort((a, b) => (b.spent_date ?? "").localeCompare(a.spent_date ?? "") || (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  }

  /** Where a ticket books: CSD → Service Desk, otherwise where this ticket or its prefix went before. */
  ticketSuggestion(key: string): TicketSuggestion | undefined {
    return suggestForTicket(key, this.projects, this.ticketHistory());
  }

  /** Tickets you logged time on lately, newest first (from the entries' Jira links). */
  recentTickets(limit = 6): JiraIssue[] {
    return recentTicketsOf(this.ticketHistory(), limit);
  }

  /** The ticket's customer organisations (Jira Service Management); empty on any problem, it's only a hint. */
  async ticketOrganizations(key: string): Promise<string[]> {
    if (!this.hasJira) return [];
    try {
      return await this.jira.organizations(key);
    } catch {
      return [];
    }
  }

  // MARK: Idle

  private idleCheckAt = 0;

  private async checkIdle() {
    if (!this.prefs.idleReminder || !this.running || this.idlePrompt) {
      this.idleSince = null;
      // No previous check: the next timer must not mistake this quiet time for sleep.
      this.idleCheckAt = 0;
      return;
    }
    // Every 5 s is plenty.
    const now = Date.now();
    if (now - this.idleCheckAt < 5000) return;
    const lastCheckAt = this.idleCheckAt;
    this.idleCheckAt = now;
    const idle = await native.idleSeconds().catch(() => 0);
    const r = idleStep({ since: this.idleSince, lastCheckAt }, now, idle);
    this.idleSince = r.since;
    if (r.prompt) {
      this.idlePrompt = r.prompt;
      this.notify();
      this.onIdleReturn?.();
    }
  }

  keepIdleTime() {
    this.idlePrompt = null;
    this.notify();
  }

  async removeIdleTime(stop: boolean) {
    const span = this.idlePrompt;
    const r = this.running;
    this.idlePrompt = null;
    this.notify();
    if (!span || !r) return;
    const mins = fmt.words((+span.end - +span.start) / 1000);
    const ok = await this.perform(async () => {
      if (r.timer_started_at) await this.keito.removeIdle(r.id, span.start, stop ? null : span.end, r.timer_started_at);
      else if (stop) await this.keito.stop(r.id, span.start);
    });
    if (ok) this.showToast(stop ? `Stopped at ${fmt.hhmm(span.start)}, ${mins} idle removed` : `Removed ${mins} idle time`);
  }

  // MARK: Plumbing

  showToast(message: string, undo?: () => Promise<void>, actionLabel?: string) {
    const id = ++this.toastSeq;
    this.toastUndo.clear();
    if (undo) this.toastUndo.set(id, undo);
    const payload: ToastMessage = { id, message, undo: !!undo, actionLabel };
    emitTo("toast", "toast", payload).catch(() => undefined);
  }

  private async runUndo(id: number) {
    const fn = this.toastUndo.get(id);
    this.toastUndo.delete(id);
    if (fn) await fn();
  }

  clearError() {
    this.lastError = null;
    this.notify();
  }

  private async perform(op: () => Promise<void>): Promise<boolean> {
    this.isBusy = true;
    this.notify();
    try {
      await op();
      await this.refreshRunning();
      return true;
    } catch (e) {
      this.lastError = friendlyError(e);
      return false;
    } finally {
      this.isBusy = false;
      this.notify();
    }
  }
}

export const store = new AppStore();

/** Re-renders the component whenever the store changes. */
export function useStore(): AppStore {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store;
}
