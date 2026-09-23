export interface ExpandRange {
  from: number;
  to: number;
}

/**
 * Unrevealed line interval of one gap, in new-file line numbers. Lines
 * `hiddenTop + 1 .. hiddenBottom` exist in the file but are not rendered
 * yet; both ends grow toward each other as context is revealed and the gap
 * closes when they meet. `hiddenBottom: null` marks the bottom-of-file gap
 * whose end is unknown until the content source stops returning lines.
 */
export interface GapState {
  /** New-file line number of the last rendered line above the gap. */
  hiddenTop: number;
  /** New-file line number of the first rendered line below the gap. */
  hiddenBottom: number | null;
}

export interface RevealCommit {
  state: GapState;
  /** Hidden lines remaining after this reveal; null while the bottom end is unknown. */
  remaining: number | null;
  /** True when nothing is left to reveal; the caller drops the gap's placeholders. */
  exhausted: boolean;
}

/**
 * Computes the next range to reveal from one side of a gap, or null when
 * that side is exhausted. 'up' reveals lines adjacent to `hiddenBottom`
 * (just above the lower hunk); 'down' reveals lines adjacent to `hiddenTop`
 * (just below the upper hunk). The two sides can never overlap — each range
 * is clamped by the opposite edge, so alternating expansions meet exactly.
 */
export function nextRevealRange(state: GapState, direction: 'up' | 'down', chunkSize: number): ExpandRange | null {
  if (direction === 'up') {
    if (state.hiddenBottom === null || state.hiddenTop >= state.hiddenBottom) return null;
    const from = Math.max(state.hiddenTop + 1, state.hiddenBottom - chunkSize + 1);
    return { from, to: state.hiddenBottom };
  }

  if (state.hiddenBottom !== null && state.hiddenTop >= state.hiddenBottom) return null;
  const to =
    state.hiddenBottom === null
      ? state.hiddenTop + chunkSize
      : Math.min(state.hiddenTop + chunkSize, state.hiddenBottom);
  return { from: state.hiddenTop + 1, to };
}

/**
 * Advances the gap state after a reveal was fetched and inserted. `range`
 * must come from `nextRevealRange` for this state; callers may clamp `to`
 * to the lines that actually arrived (e.g. when the content source ran
 * dry) — the state then advances by the smaller range.
 */
export function commitReveal(state: GapState, direction: 'up' | 'down', range: ExpandRange): RevealCommit {
  const next: GapState =
    direction === 'down'
      ? { hiddenTop: range.to, hiddenBottom: state.hiddenBottom }
      : { hiddenTop: state.hiddenTop, hiddenBottom: range.from - 1 };
  const remaining = next.hiddenBottom === null ? null : next.hiddenBottom - next.hiddenTop;
  return { state: next, remaining, exhausted: remaining !== null && remaining <= 0 };
}

/**
 * Line-number delta between the two files across an unchanged gap.
 * `gapIndex < blocks.length` refers to the gap before `blocks[gapIndex]`
 * (delta = its newStart − oldStart); `gapIndex === blocks.length` refers to
 * the gap after the last block (delta = its last new number − last old
 * number). An unchanged new-file line `n` exists in the old file at
 * `n − delta`.
 */
export function unchangedLineDelta(
  blocks: { newStartLine: number; oldStartLine: number; lines: { oldNumber?: number; newNumber?: number }[] }[],
  gapIndex: number,
): number {
  if (gapIndex < blocks.length) {
    const block = blocks[gapIndex];
    return block.newStartLine - block.oldStartLine;
  }

  const last = blocks[blocks.length - 1];
  let newEnd = last.newStartLine;
  let oldEnd = last.oldStartLine;
  last.lines.forEach(line => {
    if (line.newNumber !== undefined) newEnd = Math.max(newEnd, line.newNumber);
    if (line.oldNumber !== undefined) oldEnd = Math.max(oldEnd, line.oldNumber);
  });
  return newEnd - oldEnd;
}
