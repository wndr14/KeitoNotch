# Keito Notch for Windows

A Windows version of Keito Notch, built with [Tauri 2](https://tauri.app) (Rust + a React/TypeScript UI in WebView2).
The macOS app in `../Sources` is unchanged.

## What's in it

Everything from the Mac app, except Apple Calendar (Windows uses Google Calendar only) and "All displays".

| Mac | Windows |
|---|---|
| Edge notch: tab with ring → peek on hover → day view / entry form | ✅ left or right edge; drag the tab along the edge |
| Island (five positions) | ✅ drag it; it snaps to the nearest spot. Bottom positions sit above the taskbar |
| Menu bar style | **Tray only**: nothing on screen; the tray icon opens the day view next to the tray |
| Display: main / built-in / external / all / active | Main, **Display with the pointer**, or a specific display (falls back to main when disconnected) |
| Full-screen apps: notch tucks into the edge | ✅ rest the pointer at the edge to bring it back |
| Day view, entry form, toast with Undo, idle reminder, restart-today prompt | ✅ |
| Favourites (☆ in the form, right-click an entry, Settings → Favourites) | ✅ |
| Alternating work weeks, hours per day | ✅ |
| Text size (Default / 115% / 130%), appearance, show seconds | ✅ |
| Google Calendar: "From calendar", matching, ✓ logged, calendar picker | ✅ |
| ⌥⌘T | `Ctrl+Alt+T` |
| Menu-bar timer | Tray icon tooltip |
| Keychain | Windows Credential Manager (service `KeitoNotch`) |
| Sparkle updates | Tauri updater: daily check, optional automatic install, Settings → General → Check for updates |

Keys: `N` new entry, `S` stop / resume last, `C` from calendar, `Esc` back, `Ctrl+Enter` save,
`Ctrl+V` in the day view with a Jira link or key (`CSD-1234`) = new entry for that ticket.

### Jira tickets pick the project (Windows only for now)

Picking a ticket in the entry form (or pasting one) also fills in where it books (`src/lib/ticketRules.ts`):

1. **The same ticket was logged before** → the same project and task.
2. **`CSD-…` always books on the service-desk project** (name contains "Service Desk"; with several, the one
   whose client is "Customer support"), even over a project already in the form. The task there is the
   customer: it's taken from the ticket's Jira Service Management *Organizations* field when exactly one task
   matches; otherwise the form asks for the task instead of reusing the last one (that's another customer).
3. **Another ticket with the same prefix was logged before** → that project, unless you picked one yourself.

Fixed prefixes live in `FIXED_PREFIXES`. The reason shows next to the ticket in the form.

### When something crashes

Each window sits in an error boundary (`src/Recover.tsx`): a crash restarts that window's UI (the notch
returns to its tab) instead of leaving an empty, invisible window. Crashes and unhandled errors are written to
`%LOCALAPPDATA%\ai.keito.notch\logs\problems.log` (error, stack and component stack; no Keito or Jira data).

## Layout

```
src/lib/        app logic (ported 1:1 from the Swift services; no UI)
  keito.ts jira.ts google.ts matcher.ts duration.ts dates.ts store.ts prefs.ts native.ts
  ticketRules.ts (ticket → project/task) problems.ts (problem log)
src/notch/      notch window: NotchApp (tab, peek, controller), DayView, EntryForm, CalendarView
src/toast/      toast window
src/settings/   settings window
src-tauri/      Rust: placement (edge / island / tray, displays), full-screen detection, tray, hotkey,
                Credential Manager, OAuth loopback, idle time
```

All network calls go through `@tauri-apps/plugin-http`, limited to Keito, `*.atlassian.net` and Google
(`src-tauri/capabilities/default.json`). A Jira site on a custom domain needs adding there.

## Develop

Needs Node 22 and Rust (`brew install rust` on a Mac, [rustup](https://rustup.rs) on Windows).

```sh
npm install
npm test           # logic tests (durations, targets, Jira links, meeting matching, Google events)
cargo test --manifest-path src-tauri/Cargo.toml   # placement maths
npx tauri dev      # runs on macOS too, for UI work (idle reminder is Windows-only)
```

## Build the installer

On Windows: `npx tauri build` → `src-tauri/target/release/bundle/nsis/*.exe` (per-user install, no admin)
and `bundle/msi/*.msi`.

Without a Windows PC: push to GitHub and the workflow in `.github/workflows/windows.yml` builds both and
attaches them to the run. The installer is unsigned for now, so SmartScreen will warn ("More info → Run anyway")
until we add a code-signing certificate.

## Releasing (with auto-update)

Installed copies check `https://github.com/chrisonstein/KeitoNotch/releases/download/windows-updates/latest.json`
once a day. That's a separate "windows-updates" release, so it never clashes with the Mac app's "latest" release.

Once: add the repository secret **`TAURI_SIGNING_PRIVATE_KEY`** with the contents of
`~/.tauri/keitonotch-windows.key` (generated on the maintainer's Mac, no password; the public key is in `tauri.conf.json`).
Keep that file safe: without it you can't ship updates to installed copies.

Each release:
1. Bump `version` in `src-tauri/tauri.conf.json` and `package.json`.
2. Optional: write `release-notes/<version>.md` (shown in the update message).
3. `git tag win-v<version> && git push --tags`. CI builds and signs the installer, creates the
   `win-v<version>` release and updates the feed.

## Shared Google client (optional)

Copy `.env.example` to `.env` and fill in the team's OAuth *Desktop app* client, or set the
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` repository secrets for CI. `.env` is git-ignored. Without it, each
user enters a client in Settings → Calendar.
