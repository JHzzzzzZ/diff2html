import { DiffFile } from '../../types';
import { escapeForHtml } from '../../render-utils';
import {
  commitReveal,
  directionToward,
  GapState,
  isLineRevealed,
  lineInGap,
  nextRevealRange,
  unchangedLineDelta,
} from '../../context-expand';

export interface ContextExpansionConfig {
  contextProvider?: (path: string, from: number, to: number) => Promise<string[]>;
  fileContents?: Map<string, string[]>;
  pathResolver?: (diffPath: string) => string;
  expandChunkSize?: number;
}

const DEFAULT_CHUNK_SIZE = 20;

/** Upper bound on the chunks one `revealLine` call fetches, so a content source that never runs dry cannot loop forever. */
const MAX_REVEAL_STEPS = 500;

/** Default path resolver: strips the git `a/` / `b/` prefixes from diff paths. */
export function defaultPathResolver(diffPath: string): string {
  return diffPath.replace(/^[ab]\//, '');
}

type ExpandDirection = 'up' | 'down';
type RenderFormat = 'line-by-line' | 'side-by-side';

/** Where one placeholder row gets inserted relative to a hunk. */
interface ViewPlan {
  direction: ExpandDirection;
  leftAnchor: HTMLTableRowElement | null;
  rightAnchor: HTMLTableRowElement;
}

/** A gap's initial state plus one placeholder plan per side that can expand into it. */
interface GapPlan {
  filePath: string;
  state: GapState;
  /** old/new renumbering delta across the gap (side-by-side only). */
  delta: number;
  views: ViewPlan[];
}

/** A mounted placeholder: one row (line-by-line) or a left/right row pair (side-by-side). */
interface GapView {
  direction: ExpandDirection;
  /** [right] for line-by-line, [left, right] for side-by-side. */
  rows: HTMLTableRowElement[];
}

/**
 * One gap between rendered content: above the first hunk, between two
 * hunks, or below the last hunk. Middle gaps carry both an up view (before
 * the lower hunk) and a down view (after the upper hunk); edge gaps carry
 * only their single direction. All views of a gap share `state`, so
 * revealing from either side updates the counts of both, and the gap closes
 * once when both placeholders disappear together.
 */
interface Gap {
  filePath: string;
  state: GapState;
  delta: number;
  views: GapView[];
  /** True once the placeholders were dropped; the gap is out of play. */
  removed: boolean;
}

/** The gaps of one rendered file, in document order. */
interface FileGaps {
  gaps: Gap[];
}

/**
 * Wires "expand context" placeholders into a rendered diff file, for both
 * output formats. Revealed context lines are unchanged between the two file
 * versions, so in side-by-side mode the same text is inserted on both
 * sides, with the left side renumbered by the gap's old/new delta.
 */
export class ContextExpansionUI {
  private readonly chunkSize: number;
  private readonly contextProvider?: (path: string, from: number, to: number) => Promise<string[]>;
  private readonly fileContents?: Map<string, string[]>;
  private readonly pathResolver: (diffPath: string) => string;
  /** Mounted gaps per rendered file; `revealLine` walks these. */
  private readonly fileGaps = new Map<DiffFile, FileGaps>();

  constructor(config: ContextExpansionConfig = {}) {
    this.chunkSize = config.expandChunkSize ?? DEFAULT_CHUNK_SIZE;
    this.contextProvider = config.contextProvider;
    this.fileContents = config.fileContents;
    this.pathResolver = config.pathResolver ?? defaultPathResolver;
  }

  canExpand(file: DiffFile): boolean {
    return (
      !file.isBinary &&
      !file.isTooBig &&
      file.blocks.length > 0 &&
      (this.contextProvider !== undefined || this.fileContents !== undefined)
    );
  }

  /** Inserts the expansion placeholder rows of one rendered file. */
  wireFile(file: DiffFile, wrapper: Element): void {
    const sides = wrapper.querySelectorAll(':scope > .d2h-files-diff > .d2h-file-side-diff table > tbody');
    if (sides.length === 2) {
      this.wireSideBySide(file, sides[0], sides[1]);
      return;
    }

    const tbody = wrapper.querySelector(':scope > .d2h-file-diff tbody');
    if (tbody !== null) this.wireLineByLine(file, tbody);
  }

  private wireLineByLine(file: DiffFile, tbody: Element): void {
    const filePath = this.resolvePath(file.newName === '/dev/null' ? file.oldName : file.newName);
    const geometry = this.blockGeometry(file, tbody, 'd2h-code-linenumber');
    if (geometry.length !== file.blocks.length) return; // unexpected DOM shape: do not guess

    // Resolve all anchor rows BEFORE inserting anything: earlier insertions
    // shift later indexes.
    const rows = Array.from(tbody.children) as HTMLTableRowElement[];
    const anchorFor = (i: number, which: 'header' | 'last') => ({
      left: null,
      right: rows[which === 'header' ? geometry[i].headerRowIndex : geometry[i].lastRowIndex],
    });
    const gaps = this.planGaps(file, filePath, anchorFor).map(plan => this.mountGap(plan, false));
    this.fileGaps.set(file, { gaps });
  }

  private wireSideBySide(file: DiffFile, leftBody: Element, rightBody: Element): void {
    const filePath = this.resolvePath(file.newName === '/dev/null' ? file.oldName : file.newName);
    const leftGeometry = this.blockGeometry(file, leftBody, 'd2h-code-side-linenumber');
    const rightGeometry = this.blockGeometry(file, rightBody, 'd2h-code-side-linenumber');
    if (leftGeometry.length !== file.blocks.length || rightGeometry.length !== file.blocks.length) return;

    const leftRows = Array.from(leftBody.children) as HTMLTableRowElement[];
    const rightRows = Array.from(rightBody.children) as HTMLTableRowElement[];
    const anchorFor = (i: number, which: 'header' | 'last') => ({
      left: leftRows[which === 'header' ? leftGeometry[i].headerRowIndex : leftGeometry[i].lastRowIndex],
      right: rightRows[which === 'header' ? rightGeometry[i].headerRowIndex : rightGeometry[i].lastRowIndex],
    });
    const gaps = this.planGaps(file, filePath, anchorFor).map(plan => this.mountGap(plan, true));
    this.fileGaps.set(file, { gaps });
  }

  /**
   * Builds the gap plan of one file: the gap above the first hunk (up
   * only), one gap per pair of adjacent hunks (down from the upper hunk and
   * up from the lower hunk sharing one state), and the open-ended gap below
   * the last hunk (down only).
   */
  private planGaps(
    file: DiffFile,
    filePath: string,
    anchorFor: (
      blockIndex: number,
      which: 'header' | 'last',
    ) => {
      left: HTMLTableRowElement | null;
      right: HTMLTableRowElement;
    },
  ): GapPlan[] {
    const blocks = file.blocks;
    const plans: GapPlan[] = [];

    if (blocks[0].newStartLine > 1) {
      plans.push({
        filePath,
        state: { hiddenTop: 0, hiddenBottom: blocks[0].newStartLine - 1 },
        delta: unchangedLineDelta(blocks, 0),
        views: [viewPlan('up', anchorFor(0, 'header'))],
      });
    }

    for (let i = 0; i < blocks.length - 1; i += 1) {
      const end = blockEnd(blocks[i]);
      const nextStart = blocks[i + 1].newStartLine;
      if (nextStart - end <= 1) continue; // hunks are adjacent: no gap
      plans.push({
        filePath,
        state: { hiddenTop: end, hiddenBottom: nextStart - 1 },
        delta: unchangedLineDelta(blocks, i + 1),
        views: [viewPlan('down', anchorFor(i, 'last')), viewPlan('up', anchorFor(i + 1, 'header'))],
      });
    }

    plans.push({
      filePath,
      state: { hiddenTop: blockEnd(blocks[blocks.length - 1]), hiddenBottom: null },
      delta: unchangedLineDelta(blocks, blocks.length),
      views: [viewPlan('down', anchorFor(blocks.length - 1, 'last'))],
    });

    return plans;
  }

  /** Inserts one placeholder row per planned view and renders its button. */
  private mountGap(plan: GapPlan, paired: boolean): Gap {
    const gap: Gap = { filePath: plan.filePath, state: plan.state, delta: plan.delta, views: [], removed: false };
    plan.views.forEach(viewPlan => {
      const rows = [buildPlaceholderRow(), ...(paired ? [buildPlaceholderRow()] : [])];
      rows.forEach((row, index) => {
        const anchor = index === 0 && paired ? viewPlan.leftAnchor! : viewPlan.rightAnchor;
        if (viewPlan.direction === 'up') anchor.parentNode!.insertBefore(row, anchor);
        else anchor.parentNode!.insertBefore(row, anchor.nextSibling);
      });
      gap.views.push({ direction: viewPlan.direction, rows });
    });
    this.renderGap(gap);
    return gap;
  }

  /** Re-renders every button of the gap from the shared state. */
  private renderGap(gap: Gap): void {
    const remaining = gap.state.hiddenBottom === null ? null : gap.state.hiddenBottom - gap.state.hiddenTop;
    gap.views.forEach(view => {
      view.rows.forEach(row => {
        const cell = row.querySelector('td')!;
        cell.innerHTML = '';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `d2h-expand-${view.direction}`;
        button.textContent =
          remaining === null ? '⋯ 展开更多 ⋯' : `⋯ ${view.direction === 'up' ? '上方' : '下方'} ${remaining} 行 ⋯`;
        button.addEventListener('click', () => {
          void this.expand(gap, view, view.direction);
        });
        cell.appendChild(button);
      });
    });
  }

  private removeGap(gap: Gap): void {
    gap.removed = true;
    gap.views.forEach(view => view.rows.forEach(row => row.remove()));
  }

  /**
   * Reveals context until `lineNumber` is rendered, and returns whether it got
   * there. `side` follows review anchors: `old` anchors address the old file,
   * so they are shifted by the gap's line-number delta. Returns false when the
   * line is not hidden by any gap (already rendered, or absent) or the content
   * source ran out first.
   */
  async revealLine(file: DiffFile, side: 'old' | 'new', lineNumber: number): Promise<boolean> {
    const target = this.findGapTarget(this.fileGaps.get(file)?.gaps ?? [], side, lineNumber);
    if (target === null) return false;

    for (let step = 0; step < MAX_REVEAL_STEPS; step += 1) {
      if (isLineRevealed(target.gap.state, target.newLineNumber)) return true;
      const direction = directionToward(target.gap.state, target.newLineNumber);
      const progressed = await this.expand(target.gap, target.view, direction);
      if (!progressed) return false;
    }
    return false;
  }

  /** The live gap hiding one anchor line, with the new-file number to reveal to. */
  private findGapTarget(
    gaps: Gap[],
    side: 'old' | 'new',
    lineNumber: number,
  ): { gap: Gap; view: GapView; newLineNumber: number } | null {
    for (const gap of gaps) {
      if (gap.removed) continue;
      const newLineNumber = lineInGap(gap.state, gap.delta, side, lineNumber);
      if (newLineNumber !== null) return { gap, view: gap.views[0], newLineNumber };
    }
    return null;
  }

  /**
   * Reveals one chunk of context into one of the gap's views. Both views
   * share the gap state: whichever side is clicked, the counts of all
   * views stay in sync, and when the two sides meet every placeholder of
   * the gap is removed at once. Returns whether lines were actually
   * inserted, which `revealLine` uses to detect a dry content source.
   */
  private async expand(gap: Gap, view: GapView, direction: ExpandDirection): Promise<boolean> {
    const buttons = view.rows.flatMap(row => Array.from(row.querySelectorAll<HTMLButtonElement>('button')));
    if (buttons.some(button => button.disabled)) return false;
    buttons.forEach(button => (button.disabled = true));

    const range = nextRevealRange(gap.state, direction, this.chunkSize);
    if (range === null) {
      this.removeGap(gap);
      return false;
    }

    const openBottom = gap.state.hiddenBottom === null;
    try {
      // Probe one extra line on an open-bottom gap to detect EOF.
      const lines = await this.getLines(gap.filePath, range.from, range.to + (openBottom ? 1 : 0));
      const revealed = lines.slice(0, range.to - range.from + 1);
      const hasMore = openBottom && lines.length > revealed.length;

      if (revealed.length === 0) {
        if (openBottom) this.removeGap(gap);
        else this.renderGap(gap); // defensive: the content source came up empty
        return false;
      }

      const format: RenderFormat = view.rows.length === 2 ? 'side-by-side' : 'line-by-line';
      if (direction === 'up') this.insertBelow(view, gap.delta, range.from, revealed, format);
      else this.insertAbove(view, gap.delta, range.from, revealed, format);

      const outcome = commitReveal(gap.state, direction, {
        from: range.from,
        to: range.from + revealed.length - 1,
      });
      gap.state = outcome.state;

      if (outcome.exhausted || (openBottom && !hasMore)) {
        this.removeGap(gap);
        return true;
      }
      this.renderGap(gap);
      return true;
    } catch (error) {
      buttons.forEach(button => {
        button.disabled = false;
        button.textContent = `加载失败: ${(error as Error).message}`;
      });
      return false;
    }
  }

  /** Downward reveals accumulate right above the placeholder rows, in ascending order. */
  private insertAbove(view: GapView, delta: number, from: number, revealed: string[], format: RenderFormat): void {
    const rightRow = view.rows[view.rows.length - 1];
    const leftRow = view.rows.length === 2 ? view.rows[0] : null;
    revealed.forEach((content, idx) => {
      const newNumber = from + idx;
      const oldNumber = contextNumber(newNumber - delta);
      if (leftRow === null) {
        rightRow.parentNode!.insertBefore(
          buildContextLineRow({ old: oldNumber, new: newNumber }, content, format),
          rightRow,
        );
        return;
      }
      rightRow.parentNode!.insertBefore(buildContextLineRow({ old: null, new: newNumber }, content, format), rightRow);
      leftRow.parentNode!.insertBefore(buildContextLineRow({ old: oldNumber, new: null }, content, format), leftRow);
    });
  }

  /** Upward reveals accumulate right below the placeholder rows, in ascending order. */
  private insertBelow(view: GapView, delta: number, from: number, revealed: string[], format: RenderFormat): void {
    const rightRow = view.rows[view.rows.length - 1];
    const leftRow = view.rows.length === 2 ? view.rows[0] : null;
    let rightAnchor: ChildNode = rightRow;
    let leftAnchor: ChildNode | null = leftRow;
    revealed.forEach((content, idx) => {
      const newNumber = from + idx;
      const oldNumber = contextNumber(newNumber - delta);
      const rightLine =
        leftRow === null
          ? buildContextLineRow({ old: oldNumber, new: newNumber }, content, format)
          : buildContextLineRow({ old: null, new: newNumber }, content, format);
      rightAnchor.parentNode!.insertBefore(rightLine, rightAnchor.nextSibling);
      rightAnchor = rightLine;
      if (leftAnchor !== null) {
        const leftLine = buildContextLineRow({ old: oldNumber, new: null }, content, format);
        leftAnchor.parentNode!.insertBefore(leftLine, leftAnchor.nextSibling);
        leftAnchor = leftLine;
      }
    });
  }

  /**
   * Locates block boundaries in a tbody by scanning for hunk header rows
   * (their number cell carries the `d2h-info` class), in block order.
   */
  private blockGeometry(
    file: DiffFile,
    tbody: Element,
    linenumberClass: string,
  ): { headerRowIndex: number; lastRowIndex: number }[] {
    const rows = Array.from(tbody.children) as HTMLTableRowElement[];
    const headerIndexes = rows
      .map((row, index) => (row.querySelector(`td.${linenumberClass}.d2h-info`) !== null ? index : -1))
      .filter(index => index >= 0);

    if (headerIndexes.length !== file.blocks.length) return [];

    return file.blocks.map((_block, i) => ({
      headerRowIndex: headerIndexes[i],
      lastRowIndex: (i + 1 < headerIndexes.length ? headerIndexes[i + 1] : rows.length) - 1,
    }));
  }

  private async getLines(path: string, from: number, to: number): Promise<string[]> {
    if (this.contextProvider !== undefined) return this.contextProvider(path, from, to);
    const content = this.fileContents?.get(path);
    if (content === undefined) throw new Error(`no content source for "${path}"`);
    return content.slice(from - 1, to);
  }

  private resolvePath(diffPath: string): string {
    return this.pathResolver(diffPath);
  }
}

function viewPlan(
  direction: ExpandDirection,
  anchor: { left: HTMLTableRowElement | null; right: HTMLTableRowElement },
): ViewPlan {
  return { direction, leftAnchor: anchor.left, rightAnchor: anchor.right };
}

function blockEnd(block: DiffFile['blocks'][number]): number {
  for (let i = block.lines.length - 1; i >= 0; i--) {
    const n = block.lines[i].newNumber;
    if (n !== undefined) return n;
  }
  return block.newStartLine;
}

function buildPlaceholderRow(): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = 'd2h-context-expand-row';
  const cell = document.createElement('td');
  cell.colSpan = 2;
  cell.className = 'd2h-context-expand';
  row.appendChild(cell);
  return row;
}

/** Old-file number of a revealed context line, or null when the line has no old counterpart (it predates the file start). */
function contextNumber(oldNumber: number): number | null {
  return oldNumber < 1 ? null : oldNumber;
}

/**
 * Builds one revealed context line matching the row shape of the given format.
 * A side-by-side row is given the single number of its own side; a
 * line-by-line row is given both numbers, because unchanged context lines have
 * an old and a new number that differ by the gap delta.
 */
function buildContextLineRow(
  numbers: { old: number | null; new: number | null },
  content: string,
  format: RenderFormat,
): HTMLTableRowElement {
  const row = document.createElement('tr');
  const empty = numbers.old === null && numbers.new === null;
  row.className = 'd2h-context-line' + (empty ? ' d2h-context-filler' : '');
  const contentHtml = empty ? '&nbsp;' : escapeForHtml(content);

  if (format === 'side-by-side') {
    const number = numbers.new ?? numbers.old;
    const numberHtml = number === null ? '&nbsp;' : String(number);
    row.innerHTML =
      `<td class="d2h-code-side-linenumber d2h-cntx">\n${numberHtml}\n</td>\n` +
      `<td class="d2h-cntx">\n<div class="d2h-code-side-line">\n<span class="d2h-code-line-prefix">&nbsp;</span>\n<span class="d2h-code-line-ctn">${contentHtml}</span>\n</div>\n</td>`;
    return row;
  }

  const oldHtml = numbers.old === null ? '&nbsp;' : String(numbers.old);
  const newHtml = numbers.new === null ? '&nbsp;' : String(numbers.new);

  // Whitespace text nodes match the mustache-rendered rows: inline elements
  // separated by whitespace collapse to one space, and skipping them shifts
  // the content ~7px left of the diff lines.
  row.innerHTML =
    `<td class="d2h-code-linenumber d2h-cntx">\n` +
    `    <div class="line-num1">${oldHtml}</div>\n` +
    `    <div class="line-num2">${newHtml}</div>\n` +
    `</td>\n` +
    `<td class="d2h-cntx">\n` +
    `    <div class="d2h-code-line">\n` +
    `        <span class="d2h-code-line-prefix">&nbsp;</span>\n` +
    `        <span class="d2h-code-line-ctn">${contentHtml}</span>\n` +
    `    </div>\n` +
    `</td>`;
  return row;
}
