import { DiffFile } from '../../types';
import { escapeForHtml } from '../../render-utils';
import { computeExpandRange, unchangedLineDelta } from '../../context-expand';

export interface ContextExpansionConfig {
  contextProvider?: (path: string, from: number, to: number) => Promise<string[]>;
  fileContents?: Map<string, string[]>;
  pathResolver?: (diffPath: string) => string;
  expandChunkSize?: number;
}

const DEFAULT_CHUNK_SIZE = 20;

/** Default path resolver: strips the git `a/` / `b/` prefixes from diff paths. */
export function defaultPathResolver(diffPath: string): string {
  return diffPath.replace(/^[ab]\//, '');
}

interface GapSpec {
  direction: 'up' | 'down';
  boundary: number;
  remaining: number | null;
  bound: number;
  /** old/new line-number delta across this gap (side-by-side renumbering). */
  delta: number;
  leftAnchor: HTMLTableRowElement | null;
  rightAnchor: HTMLTableRowElement;
}

/**
 * Wires "expand context" placeholders into a rendered diff file, for both
 * output formats. Revealed context lines are unchanged between the two file
 * versions, so in side-by-side mode the same text is inserted on both sides,
 * with the left side renumbered by the gap's old/new delta.
 */
export class ContextExpansionUI {
  private readonly chunkSize: number;
  private readonly contextProvider?: (path: string, from: number, to: number) => Promise<string[]>;
  private readonly fileContents?: Map<string, string[]>;
  private readonly pathResolver: (diffPath: string) => string;

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

    const rows = Array.from(tbody.children) as HTMLTableRowElement[];
    const gaps: GapSpec[] = [];

    file.blocks.forEach((_block, i) => {
      // Gaps between hunks get a single placeholder that expands downward from
      // the previous hunk (one button per gap, no overlapping ranges). Only the
      // gap before the first hunk expands upward.
      if (i === 0) {
        const gapAbove = file.blocks[0].newStartLine - 1;
        if (gapAbove > 0) {
          gaps.push({
            direction: 'up',
            boundary: file.blocks[0].newStartLine,
            remaining: gapAbove,
            bound: file.blocks[0].newStartLine - 1,
            delta: 0,
            leftAnchor: null,
            rightAnchor: rows[geometry[0].headerRowIndex],
          });
        }
      }

      const isLast = i === file.blocks.length - 1;
      const nextStart = isLast ? null : file.blocks[i + 1].newStartLine;
      const gapBelow = nextStart === null ? null : nextStart - blockEnd(file.blocks[i]) - 1;
      if (gapBelow === null || gapBelow > 0) {
        gaps.push({
          direction: 'down',
          boundary: blockEnd(file.blocks[i]),
          remaining: gapBelow,
          bound: nextStart === null ? Number.MAX_SAFE_INTEGER : nextStart - 1,
          delta: 0,
          leftAnchor: null,
          rightAnchor: rows[geometry[i].lastRowIndex],
        });
      }
    });

    gaps.forEach(gap => this.insertPlaceholder(filePath, gap));
  }

  private wireSideBySide(file: DiffFile, leftBody: Element, rightBody: Element): void {
    const filePath = this.resolvePath(file.newName === '/dev/null' ? file.oldName : file.newName);
    const leftGeometry = this.blockGeometry(file, leftBody, 'd2h-code-side-linenumber');
    const rightGeometry = this.blockGeometry(file, rightBody, 'd2h-code-side-linenumber');
    if (leftGeometry.length !== file.blocks.length || rightGeometry.length !== file.blocks.length) return;

    // Resolve all anchor rows BEFORE inserting anything: earlier insertions
    // shift later indexes.
    const leftRows = Array.from(leftBody.children) as HTMLTableRowElement[];
    const rightRows = Array.from(rightBody.children) as HTMLTableRowElement[];
    const gaps: GapSpec[] = [];

    file.blocks.forEach((_block, i) => {
      if (i === 0) {
        const gapAbove = file.blocks[0].newStartLine - 1;
        if (gapAbove > 0) {
          gaps.push({
            direction: 'up',
            boundary: file.blocks[0].newStartLine,
            remaining: gapAbove,
            bound: file.blocks[0].newStartLine - 1,
            delta: unchangedLineDelta(file.blocks, 0),
            leftAnchor: leftRows[leftGeometry[0].headerRowIndex],
            rightAnchor: rightRows[rightGeometry[0].headerRowIndex],
          });
        }
      }

      const isLast = i === file.blocks.length - 1;
      const nextStart = isLast ? null : file.blocks[i + 1].newStartLine;
      const gapBelow = nextStart === null ? null : nextStart - blockEnd(file.blocks[i]) - 1;
      if (gapBelow === null || gapBelow > 0) {
        gaps.push({
          direction: 'down',
          boundary: blockEnd(file.blocks[i]),
          remaining: gapBelow,
          bound: nextStart === null ? Number.MAX_SAFE_INTEGER : nextStart - 1,
          delta: unchangedLineDelta(file.blocks, isLast ? file.blocks.length : i + 1),
          leftAnchor: leftRows[leftGeometry[i].lastRowIndex],
          rightAnchor: rightRows[rightGeometry[i].lastRowIndex],
        });
      }
    });

    gaps.forEach(gap => this.insertPlaceholderPair(filePath, gap));
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

  /** Single-side (line-by-line) placeholder: delta 0, no left row. */
  private insertPlaceholder(filePath: string, gap: GapSpec): void {
    const rightRow = buildPlaceholderRow();
    const anchor = gap.rightAnchor;
    anchor.parentNode!.insertBefore(rightRow, gap.direction === 'up' ? anchor : anchor.nextSibling);

    const state = { boundary: gap.boundary, remaining: gap.remaining };
    const render = (): void => {
      rightRow.querySelector('td')!.innerHTML = '';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `d2h-expand-${gap.direction}`;
      button.textContent =
        state.remaining === null
          ? '⋯ 展开更多 ⋯'
          : `⋯ ${gap.direction === 'up' ? '上方' : '下方'} ${state.remaining} 行 ⋯`;
      button.addEventListener('click', () =>
        this.expand(filePath, gap.direction, state, gap.bound, gap.delta, null, rightRow, render),
      );
      rightRow.querySelector('td')!.appendChild(button);
    };
    render();
  }

  /** Side-by-side placeholder: a synchronized pair of rows, one per side. */
  private insertPlaceholderPair(filePath: string, gap: GapSpec): void {
    const leftRow = buildPlaceholderRow();
    const rightRow = buildPlaceholderRow();
    gap.leftAnchor!.parentNode!.insertBefore(
      leftRow,
      gap.direction === 'up' ? gap.leftAnchor! : gap.leftAnchor!.nextSibling,
    );
    gap.rightAnchor.parentNode!.insertBefore(
      rightRow,
      gap.direction === 'up' ? gap.rightAnchor : gap.rightAnchor.nextSibling,
    );

    const state = { boundary: gap.boundary, remaining: gap.remaining };
    const render = (): void => {
      leftRow.querySelector('td')!.innerHTML = '';
      rightRow.querySelector('td')!.innerHTML = '';
      [leftRow, rightRow].forEach(row => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `d2h-expand-${gap.direction}`;
        button.textContent =
          state.remaining === null
            ? '⋯ 展开更多 ⋯'
            : `⋯ ${gap.direction === 'up' ? '上方' : '下方'} ${state.remaining} 行 ⋯`;
        button.addEventListener('click', () =>
          this.expand(filePath, gap.direction, state, gap.bound, gap.delta, leftRow, rightRow, render),
        );
        row.querySelector('td')!.appendChild(button);
      });
    };
    render();
  }

  /**
   * Reveals one chunk of context. In side-by-side mode (`paired`) the same
   * chunk is inserted into both sides; the left rows are renumbered by the
   * gap delta, falling back to filler rows when the old file is exhausted.
   */
  private async expand(
    filePath: string,
    direction: 'up' | 'down',
    state: { boundary: number; remaining: number | null },
    bound: number,
    delta: number,
    leftRow: HTMLTableRowElement | null,
    rightRow: HTMLTableRowElement,
    rerender: () => void,
  ): Promise<void> {
    const buttons = [rightRow, ...(leftRow ? [leftRow] : [])].flatMap(row =>
      Array.from(row.querySelectorAll<HTMLButtonElement>('button')),
    );
    if (buttons.some(b => b.disabled)) return;
    buttons.forEach(b => (b.disabled = true));

    const range = computeExpandRange({
      direction,
      boundary: state.boundary,
      fileStart: 1,
      fileEnd: bound,
      chunkSize: this.chunkSize,
    });
    if (range === null) {
      rightRow.remove();
      leftRow?.remove();
      return;
    }

    let lines: string[];
    try {
      // Request one extra line to detect whether more content remains.
      lines = await this.getLines(filePath, range.from, range.to + 1);
    } catch (error) {
      buttons.forEach(b => {
        b.disabled = false;
        b.textContent = `加载失败: ${(error as Error).message}`;
      });
      return;
    }

    const revealed = lines.slice(0, range.to - range.from + 1);
    const hasMore = lines.length > revealed.length;
    const format = leftRow !== null ? 'side-by-side' : 'line-by-line';

    if (direction === 'up') {
      // Insert below the placeholder, keeping ascending order.
      let rightAnchor: ChildNode = rightRow;
      let leftAnchor: ChildNode | null = leftRow;
      revealed.forEach((content, idx) => {
        const newNumber = range.from + idx;
        const oldNumber = newNumber - delta;
        const rightLine = buildContextLineRow(newNumber, content, format);
        rightAnchor.parentNode!.insertBefore(rightLine, rightAnchor.nextSibling);
        rightAnchor = rightLine;
        if (leftAnchor !== null) {
          const leftLine = buildContextLineRow(oldNumber < 1 ? null : oldNumber, content, format);
          leftAnchor.parentNode!.insertBefore(leftLine, leftAnchor.nextSibling);
          leftAnchor = leftLine;
        }
      });
    } else {
      // Insert right above the placeholder; sequential inserts stay ascending.
      revealed.forEach((content, idx) => {
        const newNumber = range.from + idx;
        const oldNumber = newNumber - delta;
        rightRow.parentNode!.insertBefore(buildContextLineRow(newNumber, content, format), rightRow);
        if (leftRow !== null) {
          leftRow.parentNode!.insertBefore(
            buildContextLineRow(oldNumber < 1 ? null : oldNumber, content, format),
            leftRow,
          );
        }
      });
    }

    state.boundary = direction === 'up' ? range.from : range.to;
    state.remaining = state.remaining === null ? (hasMore ? null : 0) : Math.max(0, state.remaining - revealed.length);

    if (state.remaining === 0 || state.boundary < 1 || state.boundary > bound) {
      rightRow.remove();
      leftRow?.remove();
      return;
    }

    rerender();
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

/** Builds one revealed context line matching the row shape of the given format; `lineNumber` may be null for a filler row. */
function buildContextLineRow(
  lineNumber: number | null,
  content: string,
  format: 'line-by-line' | 'side-by-side',
): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = 'd2h-context-line' + (lineNumber === null ? ' d2h-context-filler' : '');
  const empty = lineNumber === null;
  const numberHtml = empty ? '&nbsp;' : String(lineNumber);
  const contentHtml = empty ? '&nbsp;' : escapeForHtml(content);

  if (format === 'side-by-side') {
    row.innerHTML =
      `<td class="d2h-code-side-linenumber d2h-cntx">\n${numberHtml}\n</td>\n` +
      `<td class="d2h-cntx">\n<div class="d2h-code-side-line">\n<span class="d2h-code-line-prefix">&nbsp;</span>\n<span class="d2h-code-line-ctn">${contentHtml}</span>\n</div>\n</td>`;
    return row;
  }

  // Whitespace text nodes match the mustache-rendered rows: inline elements
  // separated by whitespace collapse to one space, and skipping them shifts
  // the content ~7px left of the diff lines.
  row.innerHTML =
    `<td class="d2h-code-linenumber d2h-cntx">\n` +
    `    <div class="line-num1">${numberHtml}</div>\n` +
    `    <div class="line-num2">${numberHtml}</div>\n` +
    `</td>\n` +
    `<td class="d2h-cntx">\n` +
    `    <div class="d2h-code-line">\n` +
    `        <span class="d2h-code-line-prefix">&nbsp;</span>\n` +
    `        <span class="d2h-code-line-ctn">${contentHtml}</span>\n` +
    `    </div>\n` +
    `</td>`;
  return row;
}
