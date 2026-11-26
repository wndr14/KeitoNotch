// The notch window — port of NotchController + NotchRootView.
// Styles: edge notch (left/right edge), island (floating pill, five positions) or tray only (nothing on screen
// until you click the tray icon). Follows the chosen display, tucks away next to full-screen apps, and can be
// dragged to a new spot.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { store, useStore } from "../lib/store";
import { native } from "../lib/native";
import { hasKeito, savePrefs, type IslandPos, type NotchStyle } from "../lib/prefs";
import { applyAppearance } from "../lib/appearance";
import { installUpdate, startDailyChecks } from "../lib/updates";
import { dayKey } from "../lib/dates";
import * as fmt from "../lib/duration";
import type { CalendarEvent, TimeEntry } from "../lib/models";
import { keyFromLink, looksLikeKey } from "../lib/jira";
import { reportProblem } from "../lib/problems";
import { DayRing, ClientTask, ProjectDot, Spinner, TicketChip } from "./parts";
import { Play, Plus, Stop } from "../icons";
import { DayView } from "./DayView";
import { EntryForm } from "./EntryForm";
import { CalendarView } from "./CalendarView";

export type Mode = "collapsed" | "peek" | "day" | "form" | "calendar";

export interface FormSeed {
  key: number;
  date: Date;
  editing?: TimeEntry;
  event?: CalendarEvent;
  /** A pasted Jira key: the form links it (and picks the project for it). */
  ticket?: string;
}

export interface Nav {
  mode: Mode;
  set(mode: Mode): void;
  back(): void;
  openForm(opts?: { date?: Date; editing?: TimeEntry; event?: CalendarEvent; ticket?: string }): void;
  /** Resume a row: today's continue directly; other days ask first. */
  requestResume(entry: TimeEntry): void;
  restartPrompt: TimeEntry | null;
  setRestartPrompt(e: TimeEntry | null): void;
  form: FormSeed;
}

const isOpen = (m: Mode) => m === "day" || m === "form" || m === "calendar";

/** Logical size per mode and style (before the text-size zoom). */
export function sizeFor(mode: Mode, style: NotchStyle, wideTab: boolean) {
  if (isOpen(mode) || style === "tray") return { w: 392, h: 600 };
  if (style === "island") return mode === "peek" ? { w: 340, h: 84 } : { w: wideTab ? 136 : 112, h: 44 };
  return mode === "peek" ? { w: 316, h: 96 } : { w: wideTab ? 70 : 50, h: 96 };
}

/** How long the tab ↔ peek morph takes; the window shrinks only after it. Keep in sync with --morph in styles.css. */
export const MORPH_MS = 220;

/**
 * The side of the window that stays put when the tab grows into the peek card. Mirrors compute() in
 * placement.rs: the window grows away from this corner, so drawing the tab and the card against it keeps
 * the tab still on screen while the window changes size underneath.
 */
export function morphAnchor(style: NotchStyle, edge: string, island: IslandPos): { x: "left" | "right" | "center"; y: "top" | "bottom" } {
  if (style !== "island") return { x: edge === "left" ? "left" : "right", y: "top" };
  const x = island.endsWith("Left") ? "left" : island.endsWith("Right") ? "right" : "center";
  return { x, y: island.startsWith("bottom") ? "bottom" : "top" };
}

/** Where a box of `box` size sits inside a window of `win` size against an anchor (CSS px). */
export function hitRect(a: ReturnType<typeof morphAnchor>, win: { w: number; h: number }, box: { w: number; h: number }) {
  return {
    x: a.x === "left" ? 0 : a.x === "right" ? win.w - box.w : (win.w - box.w) / 2,
    y: a.y === "top" ? 0 : win.h - box.h,
    w: box.w,
    h: box.h,
  };
}

/** Absolute position (CSS) for a box of w×h against an anchor. */
function anchored(a: ReturnType<typeof morphAnchor>, w: number, h: number): CSSProperties {
  return {
    width: w,
    height: h,
    top: a.y === "top" ? 0 : "auto",
    bottom: a.y === "bottom" ? 0 : "auto",
    left: a.x === "left" ? 0 : a.x === "center" ? "50%" : "auto",
    right: a.x === "right" ? 0 : "auto",
    transform: a.x === "center" ? "translateX(-50%)" : undefined,
  };
}

/** Island drop target: top or bottom half, then left / centre / right third (bottom has no centre: the taskbar). */
export function snapIsland(fx: number, fy: number): IslandPos {
  if (fy >= 0.5) return fx < 0.5 ? "bottomLeft" : "bottomRight";
  return fx < 1 / 3 ? "topLeft" : fx > 2 / 3 ? "topRight" : "top";
}

/** A Jira key in pasted text: a ticket link, or just the key ("CSD-1234"). */
export function ticketKeyIn(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 2000) return null;
  return keyFromLink(t) ?? (looksLikeKey(t) ? t.toUpperCase() : null);
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

/** Eats the click that ends a drag, so dropping the notch doesn't also press the ring or open the day view. */
function swallowNextClick() {
  const eat = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", eat, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", eat, { capture: true }), 150);
}

export interface DragHandlers {
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(e: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(e: ReactPointerEvent<HTMLElement>): void;
}

export function NotchApp() {
  const s = useStore();
  const [mode, setMode] = useState<Mode>("collapsed");
  const [form, setForm] = useState<FormSeed>({ key: 0, date: new Date() });
  const [restartPrompt, setRestartPrompt] = useState<TimeEntry | null>(null);
  /** Hidden next to a full-screen app until the pointer rests at the edge. */
  const [tucked, setTucked] = useState(false);
  /** Bumped when "Active display" should move the notch to the pointer's screen. */
  const [displayTick, setDisplayTick] = useState(0);
  const [dragPos, setDragPos] = useState<number | null>(null);
  const [dragIsland, setDragIsland] = useState<IslandPos | null>(null);
  const hoverTimer = useRef<number>();
  /** Peek card drawn at full size (true) or still/again at tab size (false) — the morph's state. */
  const [grown, setGrown] = useState(false);
  const shrinkTimer = useRef<number>();
  const settingsOffered = useRef(false);
  const currentMonitor = useRef("");
  const blurClosedAt = useRef(0);
  const drag = useRef<{ x: number; y: number; active: boolean; pending: boolean } | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const tuckedRef = useRef(tucked);
  tuckedRef.current = tucked;

  const set = useCallback((m: Mode) => {
    window.clearTimeout(hoverTimer.current);
    window.clearTimeout(shrinkTimer.current);
    setMode(m);
    if (isOpen(m)) void getCurrentWindow().setFocus();
    if (m === "collapsed") setRestartPrompt(null);
  }, []);

  const openForm = useCallback((opts: { date?: Date; editing?: TimeEntry; event?: CalendarEvent; ticket?: string } = {}) => {
    setForm((f) => ({
      key: f.key + 1,
      date: opts.event ? new Date(opts.event.start) : opts.date ?? store.selectedDay,
      editing: opts.editing,
      event: opts.event,
      ticket: opts.ticket,
    }));
    set("form");
  }, [set]);

  const back = useCallback(() => {
    switch (modeRef.current) {
      case "form": set(form.event ? "calendar" : "day"); break;
      case "calendar": set("day"); break;
      case "day":
      case "peek": set("collapsed"); break;
      default: break;
    }
  }, [set, form.event]);

  const requestResume = useCallback((e: TimeEntry) => {
    if (e.spent_date === dayKey(new Date())) void store.resume(e);
    else setRestartPrompt(e);
  }, []);

  const nav: Nav = { mode, set, back, openForm, requestResume, restartPrompt, setRestartPrompt, form };

  // Start: load data, listen to the tray / hotkey / other windows, check for updates.
  useEffect(() => {
    void store.start();
    store.onIdleReturn = () => set("day");
    const offs = [
      listen("toggle-day", () => {
        // Clicking the tray icon first takes focus away (which already closed the notch): keep it closed.
        if (Date.now() - blurClosedAt.current < 400) return;
        set(isOpen(modeRef.current) ? "collapsed" : "day");
      }),
      listen("new-entry", () => openForm({ date: new Date() })),
      listen<{ credentials: boolean }>("settings-changed", (e) => {
        applyAppearance();
        if (e.payload.credentials) void store.reload();
        else store.reloadPrefs();
      }),
      // Clicking anywhere else closes an open notch.
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused && isOpen(modeRef.current)) {
          blurClosedAt.current = Date.now();
          set("collapsed");
        }
      }),
    ];
    const stopUpdates = startDailyChecks((update) =>
      store.showToast(`Keito Notch ${update.version} is available`, () => installUpdate(update), "Install"));
    return () => {
      offs.forEach((p) => void p.then((off) => off()));
      stopUpdates();
    };
  }, [set, openForm]);

  // First run: no Keito key yet → open the setup in Settings once.
  useEffect(() => {
    if (s.loaded && !hasKeito(s.creds) && !settingsOffered.current) {
      settingsOffered.current = true;
      void native.openSettings("keito");
    }
  }, [s.loaded, s.creds]);

  const { style, edge, display, textSize } = s.prefs;
  const position = dragPos ?? s.prefs.position;
  const island = dragIsland ?? s.prefs.island;
  const open = isOpen(mode);
  const visible = style === "tray" ? open : open || mode === "peek" || !tucked;
  const zoom = textSize === "larger" ? 1.3 : textSize === "large" ? 1.15 : 1;
  const wideTab = s.prefs.showSeconds && !!s.running;
  // Tab and peek share one card-sized window and one surface that changes size in CSS (the morph).
  const morphMode = style !== "tray" && (mode === "collapsed" || mode === "peek");
  const anchor = morphAnchor(style, edge, island);
  const tabSize = sizeFor("collapsed", style, wideTab);
  const peekSize = sizeFor("peek", style, wideTab);
  const size = morphMode ? peekSize : sizeFor(mode, style, wideTab);
  const w = Math.round(size.w * zoom);
  const h = Math.round(size.h * zoom);

  // Size, place and show (or hide) the window.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!visible) {
        await native.hideNotch();
        return;
      }
      const monitor = await native.placeNotch({ width: w, height: h, style, edge, position, island, display });
      if (cancelled) return;
      currentMonitor.current = monitor;
      await native.showNotch();
      if (isOpen(modeRef.current)) void getCurrentWindow().setFocus();
    })();
    return () => {
      cancelled = true;
    };
  }, [w, h, style, edge, position, island, display, displayTick, visible]);

  // Any mode other than peek starts from the tab size again (a click from peek opens the day view).
  useEffect(() => {
    if (mode !== "peek") setGrown(false);
  }, [mode]);

  // Hover morph without resizing: in tab and peek mode the window keeps the card's size. Collapsed, it is
  // clipped to the tab (clicks beside it fall through); on hover the clip goes and the card grows in CSS.
  // Runs after the placement effect above, so the main thread places the window before clipping it.
  const [dprTick, setDprTick] = useState(0);
  useEffect(() => {
    const onResize = () => setDprTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    if (!morphMode) {
      void native.setHitRegion(null).catch(() => undefined);
      return;
    }
    if (mode === "peek") {
      let live = true;
      void native.setHitRegion(null)
        .catch(() => undefined)
        .then(() => requestAnimationFrame(() => {
          if (live && modeRef.current === "peek") setGrown(true);
        }));
      return () => {
        live = false;
      };
    }
    const r = hitRect(anchor, peekSize, tabSize);
    const dpr = window.devicePixelRatio || 1;
    void native.setHitRegion({
      x: Math.floor(r.x * dpr),
      y: Math.floor(r.y * dpr),
      w: Math.ceil(r.w * dpr),
      h: Math.ceil(r.h * dpr),
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, morphMode, anchor.x, anchor.y, tabSize.w, tabSize.h, peekSize.w, peekSize.h, dprTick]);

  // Twice a second: follow the pointer's display, tuck away next to full-screen apps.
  useEffect(() => {
    let edgeHits = 0;
    let revealedAt = 0;
    let reTopLogged = 0;
    const timer = window.setInterval(async () => {
      const p = store.prefs;
      if (p.style === "tray") return;
      const st = await native.screenState(p.style, p.edge, p.island).catch(() => null);
      // Rare and invisible otherwise: note the first few, so the log shows how often Windows buries the notch.
      if (st?.reTopped && reTopLogged++ < 5) reportProblem("notch was below other windows; put back on top", "z-order");
      if (!st || drag.current?.active) return;
      const m = modeRef.current;
      if (p.display === "active" && m === "collapsed" && st.pointerMonitor && st.pointerMonitor !== currentMonitor.current) {
        currentMonitor.current = st.pointerMonitor;
        setDisplayTick((t) => t + 1);
      }
      if (!st.fullscreen) {
        edgeHits = 0;
        if (tuckedRef.current) setTucked(false);
        return;
      }
      if (m !== "collapsed") return;
      if (tuckedRef.current) {
        // Rest at the edge for a moment (like the auto-hiding taskbar) to bring it back.
        edgeHits = st.atEdge ? edgeHits + 1 : 0;
        if (edgeHits >= 2) {
          edgeHits = 0;
          revealedAt = Date.now();
          setTucked(false);
        }
      } else if (!st.overNotch && !st.atEdge && Date.now() - revealedAt > 1500) {
        setTucked(true);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  // Keyboard: Esc goes one level back; N / S / C in the day view and peek.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        back();
        return;
      }
      if (isTyping(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
      const m = modeRef.current;
      if (m !== "day" && m !== "peek") return;
      const k = e.key.toLowerCase();
      if (k === "n") openForm({ date: m === "day" ? store.selectedDay : new Date() });
      else if (k === "c" && m === "day" && store.calendarConnected) set("calendar");
      else if (k === "s") stopOrResumeLast(requestResume);
      else return;
      e.preventDefault();
    };
    // Ctrl+V with a Jira link or key in the day view: a new entry for that ticket.
    const onPaste = (e: ClipboardEvent) => {
      if (modeRef.current !== "day" || isTyping(e.target)) return;
      const key = ticketKeyIn(e.clipboardData?.getData("text") ?? "");
      if (!key) return;
      e.preventDefault();
      openForm({ date: store.selectedDay, ticket: key });
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("paste", onPaste);
    };
  }, [back, openForm, set, requestResume]);

  // Drag the collapsed notch: the edge notch slides along the edge; the island snaps to the nearest spot.
  const dragHandlers: DragHandlers = {
    onPointerDown(e) {
      if (e.button !== 0) return;
      window.clearTimeout(hoverTimer.current);
      drag.current = { x: e.screenX, y: e.screenY, active: false, pending: false };
    },
    onPointerMove(e) {
      const d = drag.current;
      if (!d) return;
      if (!d.active) {
        if (Math.hypot(e.screenX - d.x, e.screenY - d.y) < 5) return;
        // Capture only once it's a drag, so a plain click still reaches the ring button.
        d.active = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      if (d.pending) return;
      d.pending = true;
      const p = store.prefs;
      void native.screenState(p.style, p.edge, p.island).then((st) => {
        d.pending = false;
        if (drag.current !== d) return;
        if (p.style === "island") setDragIsland(snapIsland(st.fx, st.fy));
        else setDragPos(Math.min(0.96, Math.max(0.04, st.fy)));
      });
    },
    onPointerUp() {
      const d = drag.current;
      drag.current = null;
      if (!d?.active) return;
      swallowNextClick();
      if (dragPos !== null) savePrefs({ position: dragPos });
      if (dragIsland !== null) savePrefs({ island: dragIsland });
      store.reloadPrefs();
      setDragPos(null);
      setDragIsland(null);
    },
  };

  const onEnter = () => {
    if (!s.prefs.expandOnHover || drag.current || style === "tray") return;
    if (mode === "peek") {
      // Back while the card was shrinking: grow it again instead of collapsing.
      window.clearTimeout(shrinkTimer.current);
      setGrown(true);
      return;
    }
    if (mode !== "collapsed") return;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setMode((m) => (m === "collapsed" ? "peek" : m)), 250);
  };
  const onLeave = () => {
    window.clearTimeout(hoverTimer.current);
    if (mode !== "peek") return;
    // Shrink the card back into the tab first; the window follows when that's done, so it never jumps.
    setGrown(false);
    window.clearTimeout(shrinkTimer.current);
    shrinkTimer.current = window.setTimeout(() => setMode((m) => (m === "peek" ? "collapsed" : m)), MORPH_MS);
  };

  const shape = style === "edge" ? `edge-${edge}` : style === "island" ? `island ${island.startsWith("bottom") ? "from-bottom" : "from-top"}` : "tray";
  // Tab and peek: one surface that changes size in CSS (the morph); other modes fill the window.
  const morphing = morphMode;
  const surface = grown ? peekSize : tabSize;
  // Layers sit inside the 1 px border.
  const layer = (sz: { w: number; h: number }) => anchored(anchor, sz.w - 2, sz.h - 2);
  return (
    <div
      key={open ? "open" : morphing ? "morph" : mode}
      className={`notch ${shape} ${open ? "open" : ""} ${morphing ? "morph" : mode === "collapsed" ? "" : "enter"}`}
      style={morphing ? anchored(anchor, surface.w, surface.h) : undefined}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {morphing && (
        <div className={`morph-layer ${grown ? "faded" : ""}`} style={layer(tabSize)}>
          <Tab nav={nav} island={style === "island"} drag={dragHandlers} quiet={s.prefs.expandOnHover} />
        </div>
      )}
      {morphing && mode === "peek" && (
        <div className={`morph-layer ${grown ? "" : "faded"}`} style={layer(peekSize)}>
          <Peek nav={nav} />
        </div>
      )}
      {mode === "day" && <DayView nav={nav} />}
      {mode === "form" && <EntryForm key={form.key} nav={nav} />}
      {mode === "calendar" && <CalendarView nav={nav} />}
    </div>
  );
}

/** S: stop the running timer, or resume the last entry. */
function stopOrResumeLast(requestResume: (e: TimeEntry) => void) {
  if (store.running) {
    void store.stopRunning();
    return;
  }
  const last = store.recent.find((e) => !e.is_running);
  if (last) requestResume(last);
}

/** Ring with ■ (stop) or + (new entry) in the middle; always clickable. */
function RingButton({ size, onNewEntry, quiet = false }: { size: number; onNewEntry: () => void; quiet?: boolean }) {
  const s = useStore();
  const running = !!s.running;
  const target = s.target(new Date());
  const fraction = target > 0 ? s.todaySeconds / target : 0;
  const disc = size * 0.6;
  const label = running ? "Stop timer" : "New entry";
  return (
    <button
      className="ring-btn"
      style={{ width: size, height: size }}
      disabled={s.isBusy}
      title={quiet ? undefined : `Today ${fmt.short(s.todaySeconds)} of ${fmt.short(target)} · ${label}`}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        if (running) void s.stopRunning();
        else onNewEntry();
      }}
    >
      <DayRing fraction={fraction} size={size} />
      {s.isBusy ? (
        <Spinner />
      ) : (
        <span className="ring-disc" style={{ width: disc, height: disc, background: running ? "var(--danger)" : "var(--accent)", color: running ? "#fff" : "var(--accent-ink)" }}>
          {running ? <Stop size={disc * 0.5} /> : <Plus size={disc * 0.6} strokeWidth={2.4} />}
        </span>
      )}
    </button>
  );
}

/** Collapsed: ring + timer, stacked (edge) or side by side (island). Click opens the day view; drag moves it. */
/**
 * `quiet`: no tooltips — used while "Peek on hover" is on. Hovering opens the card after 250 ms, long
 * before a tooltip would; but Chromium takes the tooltip text when the pointer arrives and shows it ~1 s
 * later anyway, over the grown card (filmed twice). Removing the title once the card grows is too late.
 */
function Tab({ nav, island, drag, quiet = false }: { nav: Nav; island: boolean; drag: DragHandlers; quiet?: boolean }) {
  const s = useStore();
  return (
    <div
      className={`tab ${island ? "row-tab" : ""}`}
      role="button"
      title={quiet ? undefined : "Click for the day view · drag to move · right-click for settings"}
      aria-label={s.running ? `Timer running for ${s.projectName(s.running)}. Open day view` : "No timer running. Open day view"}
      onClick={() => nav.set("day")}
      onContextMenu={(e) => {
        e.preventDefault();
        void native.openSettings();
      }}
      {...drag}
    >
      <RingButton size={island ? 26 : 34} onNewEntry={() => nav.openForm({ date: new Date() })} quiet={quiet} />
      <span className="time num">
        {s.running ? fmt.timer(s.elapsed, s.prefs.showSeconds) : <span className="muted">–</span>}
      </span>
    </div>
  );
}

function Peek({ nav }: { nav: Nav }) {
  const s = useStore();
  const r = s.running;
  const target = s.target(new Date());
  return (
    <div className="peek" onClick={() => nav.set("day")}>
      <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {r ? (
          <>
            <div className="row" style={{ gap: 8 }}>
              <ProjectDot id={r.project_id ?? r.project?.id} />
              <span className="ellipsis" style={{ fontWeight: 600 }}>{s.projectName(r)}</span>
            </div>
            <div className="row muted" style={{ fontSize: 12, gap: 6 }}>
              <ClientTask client={s.clientName(r)} task={r.task?.name} />
              {r.external_reference?.id && <TicketChip ticketKey={r.external_reference.id} />}
            </div>
          </>
        ) : (
          <>
            <span style={{ fontWeight: 600 }}>No timer running</span>
            <span className="muted" style={{ fontSize: 12 }}>
              Today {fmt.short(s.todaySeconds)} of {fmt.short(target)}
              {fmt.overTargetSuffix(s.todaySeconds, target)}
            </span>
          </>
        )}
      </div>
      {r ? (
        <>
          <span className="clock num">
            {fmt.short(s.elapsed)}
            {s.prefs.showSeconds && <small>:{String(Math.floor(s.elapsed) % 60).padStart(2, "0")}</small>}
          </span>
          <button
            className="round-btn stop"
            title="Stop timer"
            aria-label="Stop timer"
            disabled={s.isBusy}
            onClick={(e) => {
              e.stopPropagation();
              void s.stopRunning();
            }}
          >
            <Stop size={12} />
          </button>
        </>
      ) : (
        <button
          className="round-btn play"
          title="Start a new timer"
          aria-label="Start a new timer"
          onClick={(e) => {
            e.stopPropagation();
            nav.openForm({ date: new Date() });
          }}
        >
          <Play size={12} />
        </button>
      )}
    </div>
  );
}

