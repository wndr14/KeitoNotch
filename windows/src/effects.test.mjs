// Guards the crash behind "the notch vanishes when I pick something" (backlog S13, found 26-11 via problems.log):
// `useEffect(() => ref.current?.scrollIntoView(...))` returned what scrollIntoView returns. In current WebView2
// that is a Promise; React keeps it as the clean-up and calls it on the next run or unmount:
// "TypeError: n is not a function", and the whole UI unmounted. An effect body must be a block (or return a
// clean-up function), never a bare expression whose value React would take as its clean-up.
// Plain JS (.mjs): it reads files with Node, and the app's tsconfig has no Node types.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [p] : [];
  });
}

/** Effects whose callback is an expression-bodied arrow that isn't itself a function, or an async callback. */
function badEffects(file) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const where = (n) => `${path.relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (n) => {
    if (ts.isCallExpression(n) && /(^|\.)use(Layout|Insertion)?Effect$/.test(n.expression.getText(sf))) {
      const cb = n.arguments[0];
      if (cb && ts.isArrowFunction(cb) && !ts.isBlock(cb.body) && !ts.isArrowFunction(cb.body) && !ts.isFunctionExpression(cb.body)) {
        found.push(`${where(n)} ${cb.body.getText(sf).slice(0, 60)}`);
      }
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        found.push(`${where(n)} async effect (returns a Promise)`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("effects never hand React a non-function clean-up", () => {
  it("no expression-bodied or async effect callbacks in src/", () => {
    expect(sourceFiles(SRC).flatMap(badEffects)).toEqual([]);
  });
});
