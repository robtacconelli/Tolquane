/**
 * What is wrong with the file, in the margin.
 *
 * Check's problems and the parser's own complaint both land here: a dot in a gutter of
 * its own, the line washed in the colour of the severity, and the message on the marker's
 * tooltip. The editor takes them as a plain array and maps them to lines itself, so
 * nothing outside has to know about CodeMirror's ranges.
 */

import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from '@codemirror/view';

export interface CodeProblem {
  /** One-based, as an error message counts. */
  line: number;
  message: string;
  severity: 'error' | 'warning';
}

export const setProblems = StateEffect.define<readonly CodeProblem[]>();

export const problemsField = StateField.define<readonly CodeProblem[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setProblems)) return effect.value;
    }
    return value;
  },
});

class ProblemMarker extends GutterMarker {
  private readonly problem: CodeProblem;

  constructor(problem: CodeProblem) {
    super();
    this.problem = problem;
  }

  override eq(other: ProblemMarker): boolean {
    return (
      other.problem.message === this.problem.message &&
      other.problem.severity === this.problem.severity
    );
  }

  override toDOM(): HTMLElement {
    const dot = document.createElement('span');
    dot.className = 'cm-problemMarker';
    dot.dataset['severity'] = this.problem.severity;
    dot.title = this.problem.message;
    return dot;
  }
}

/** The problem on a given one-based line, worst first. */
function problemAt(problems: readonly CodeProblem[], line: number): CodeProblem | null {
  const here = problems.filter((problem) => problem.line === line);
  return here.find((problem) => problem.severity === 'error') ?? here[0] ?? null;
}

const errorLine = Decoration.line({ class: 'cm-problemLine' });

const problemLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    const problems = tr.state.field(problemsField);
    if (problems.length === 0) return Decoration.none;
    if (!tr.docChanged && problems === tr.startState.field(problemsField)) return value;
    const builder = new RangeSetBuilder<Decoration>();
    const lines = [...new Set(problems.map((problem) => problem.line))].sort((a, b) => a - b);
    for (const line of lines) {
      if (line < 1 || line > tr.state.doc.lines) continue;
      builder.add(tr.state.doc.line(line).from, tr.state.doc.line(line).from, errorLine);
    }
    return builder.finish();
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function codeProblems(): Extension {
  return [
    problemsField,
    problemLines,
    gutter({
      class: 'cm-problemGutter',
      lineMarker: (view, block) => {
        const problems = view.state.field(problemsField);
        if (problems.length === 0) return null;
        const line = view.state.doc.lineAt(block.from).number;
        const found = problemAt(problems, line);
        return found ? new ProblemMarker(found) : null;
      },
      lineMarkerChange: (update) =>
        update.startState.field(problemsField) !== update.state.field(problemsField),
      initialSpacer: () => new ProblemMarker({ line: 0, message: '', severity: 'error' }),
    }),
  ];
}

/** Put the cursor at the start of a one-based line and bring it into view. */
export function revealLine(view: EditorView, line: number): void {
  const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
  const target = view.state.doc.line(clamped);
  view.dispatch({
    selection: { anchor: target.from, head: target.to },
    effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
    scrollIntoView: true,
  });
}
