export interface ExpandRangeInput {
  direction: 'up' | 'down';
  /** New-file line number of the hunk edge we are expanding away from. */
  boundary: number;
  fileStart: number;
  fileEnd: number;
  chunkSize: number;
}

export interface ExpandRange {
  from: number;
  to: number;
}

/**
 * Compute the line range to reveal when expanding context in one direction.
 * Returns null when there is nothing left to reveal on that side.
 */
export function computeExpandRange(input: ExpandRangeInput): ExpandRange | null {
  const { direction, boundary, fileStart, fileEnd, chunkSize } = input;

  if (direction === 'up') {
    if (boundary <= fileStart) return null;
    const from = Math.max(fileStart, boundary - chunkSize);
    return { from, to: boundary - 1 };
  }

  if (boundary >= fileEnd) return null;
  const to = Math.min(fileEnd, boundary + chunkSize);
  return { from: boundary + 1, to };
}

/**
 * Line-number delta between the two files across an unchanged gap.
 * `gapIndex < blocks.length` refers to the gap before `blocks[gapIndex]`
 * (delta = its newStart − oldStart); `gapIndex === blocks.length` refers to the
 * gap after the last block (delta = its last new number − last old number).
 * An unchanged new-file line `n` exists in the old file at `n − delta`.
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
