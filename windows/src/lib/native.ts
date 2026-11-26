// Thin wrappers around the Rust commands (src-tauri/src/lib.rs) and Tauri plugins.
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";

export type SecretKey = "keito.apiKey" | "jira.token" | "google.clientSecret" | "google.refreshToken";

/** Windows Credential Manager. */
export const secrets = {
  get: (key: SecretKey) => invoke<string | null>("secret_get", { key }),
  set: (key: SecretKey, value: string | null) => invoke<void>("secret_set", { key, value }),
};

/** HTTP without CORS limits (Keito, Jira and Google don't send CORS headers for desktop apps). */
export const http: typeof fetch = (input, init) => tauriFetch(input, init);

export const openExternal = (url: string) => openUrl(url);

export interface PlaceArgs {
  width: number;
  height: number;
  style: string;
  edge: string;
  position: number;
  island: string;
  display: string;
}

export interface ScreenState {
  pointerMonitor: string | null;
  notchMonitor: string;
  fullscreen: boolean;
  atEdge: boolean;
  overNotch: boolean;
  /** The notch had sunk below an ordinary window and was put back on top. */
  reTopped: boolean;
  /** Primary mouse button held down. */
  mouseDown: boolean;
  fx: number;
  fy: number;
}

export interface MonitorInfo {
  name: string;
  label: string;
  primary: boolean;
}

export const native = {
  /** Sizes and moves the notch; returns the monitor it's on. */
  placeNotch: (args: PlaceArgs) => invoke<string>("place_notch", { args }),
  monitors: () => invoke<MonitorInfo[]>("monitors"),
  screenState: (style: string, edge: string, island: string) => invoke<ScreenState>("screen_state", { style, edge, island }),
  showNotch: () => invoke<void>("show_notch"),
  hideNotch: () => invoke<void>("hide_notch"),
  /** Clip the notch window to a rectangle (physical px from its top-left); null shows all of it. */
  setHitRegion: (rect: { x: number; y: number; w: number; h: number } | null) => invoke<void>("set_hit_region", { rect }),
  showToast: (width: number, height: number) => invoke<void>("show_toast", { width, height }),
  hideToast: () => invoke<void>("hide_toast"),
  openSettings: (section?: string) => invoke<void>("open_settings", { section: section ?? null }),
  setTrayTooltip: (text: string) => invoke<void>("set_tray_tooltip", { text }),
  idleSeconds: () => invoke<number>("idle_seconds"),
  quit: () => invoke<void>("quit"),
  oauthListen: () => invoke<number>("oauth_listen"),
  oauthWait: (timeoutSecs: number) => invoke<Record<string, string>>("oauth_wait", { timeoutSecs }),
  /** One line in %LOCALAPPDATA%\ai.keito.notch\logs\problems.log. */
  logProblem: (line: string) => invoke<void>("log_problem", { line }),
};
