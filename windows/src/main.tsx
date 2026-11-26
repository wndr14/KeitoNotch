// One bundle, three windows: ?view=notch | toast | settings.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { applyAppearance } from "./lib/appearance";
import { loadPrefs, TEXT_SCALE } from "./lib/prefs";
import { NotchApp } from "./notch/NotchApp";
import { ToastApp } from "./toast/ToastApp";
import { SettingsApp } from "./settings/SettingsApp";
import { Recover } from "./Recover";
import { installProblemLog } from "./lib/problems";

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "notch";

/** Text size (Settings → Notch): the notch and toast zoom as a whole; their windows grow to match. */
let zoom = 0;
function applyTextSize() {
  if (view === "settings") return;
  const z = TEXT_SCALE[loadPrefs().textSize] ?? 1;
  if (z === zoom) return;
  zoom = z;
  getCurrentWebview().setZoom(z).catch(() => undefined);
}

applyAppearance();
applyTextSize();
// Another window changed a preference.
window.addEventListener("storage", () => {
  applyAppearance();
  applyTextSize();
});
document.body.classList.add(view === "settings" ? "window" : "transparent");

// No browser context menu (right-click "Reload", "Inspect") in the notch and toast.
if (view !== "settings") document.addEventListener("contextmenu", (e) => e.preventDefault());

installProblemLog(view);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Recover>
      {view === "toast" ? <ToastApp /> : view === "settings" ? <SettingsApp initialSection={params.get("section") ?? "keito"} /> : <NotchApp />}
    </Recover>
  </StrictMode>,
);
