// Error boundary for each window. Without it a crash anywhere (render, or an effect's clean-up) unmounts the
// whole React tree: the notch window stays on screen but empty and transparent, so the app seems to vanish
// (backlog S13). With it the crash is logged and the window starts again from scratch a moment later.
import { Component, type ReactNode } from "react";
import { reportProblem } from "./lib/problems";

interface State {
  /** Showing nothing until the fresh start. */
  failed: boolean;
  /** Bumped per fresh start: a new key remounts everything below with fresh state. */
  generation: number;
}

export class Recover extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, generation: 0 };
  private timer: number | undefined;
  private recentCrashes: number[] = [];

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    reportProblem("ui crash", error, info.componentStack);
    const now = Date.now();
    this.recentCrashes = [...this.recentCrashes.filter((t) => now - t < 60_000), now];
    if (!shouldRestart(this.recentCrashes, now)) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.setState((s) => ({ failed: false, generation: s.generation + 1 })), 150);
  }

  componentWillUnmount() {
    window.clearTimeout(this.timer);
  }

  render() {
    if (this.state.failed) return null;
    return <Fresh key={this.state.generation}>{this.props.children}</Fresh>;
  }
}

function Fresh({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** Start again, unless it's a crash loop (more than 5 in a minute): then the log has what we need. Pure. */
export function shouldRestart(crashTimes: number[], now: number): boolean {
  return crashTimes.filter((t) => now - t < 60_000).length <= 5;
}
