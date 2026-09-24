import { DiffFile } from '../../types';
import { getHtmlId } from '../../render-utils';
import { newCommentId, Comment, CommentSide, ReviewImportResult, ReviewStore } from '../../review';

/** Reveals an anchor hidden by collapsed context; resolves `false` when the line cannot be reached. */
export type RevealLine = (file: DiffFile, side: CommentSide, lineNumber: number) => Promise<boolean>;

export interface ReviewUIConfig {
  author?: string;
  onReviewChange?: (reviewJson: string) => void;
  /** Supplied by the context expansion UI through `Diff2HtmlUI`. */
  revealLine?: RevealLine;
}

/** What one `importReview` call accepted, and how much of it the diff can show. */
export interface ReviewImportReport extends ReviewImportResult {
  /** Accepted comments that found their row (or file panel) in the rendered diff. */
  placed: number;
  /** Accepted comments the diff cannot show (unknown file, or a line that is not in it). */
  unplaced: number;
  /** Ready-to-display one-line summary of the import. */
  message: string;
}

type Format = 'line-by-line' | 'side-by-side';

/**
 * Wires review comments into a rendered diff: hovering a line reveals an
 * animated comment button in its number gutter, and clicking either the button
 * or the number cell itself comments on that line. The header button comments
 * on the whole file. Lines that already carry comments keep a permanent gutter
 * marker, the toolbar counts the comments and opens a navigation panel listing
 * every one of them, and importing a review reveals the collapsed lines its
 * comments point at. Comments are anchored to (filePath, lineNumber, side) and
 * survive context expansion. In side-by-side mode, rows inserted into one table
 * are mirrored by a hidden twin row in the other table so both sides stay
 * row-aligned.
 */
export class ReviewUI {
  readonly store = new ReviewStore();
  private readonly author: string;
  private readonly onReviewChange?: (reviewJson: string) => void;
  private readonly revealLine?: RevealLine;
  private readonly sessionOwned = new Set<string>();
  /** Ids the last `renderAll` attached to the DOM; comments missing here could not be placed. */
  private readonly placed = new Set<string>();
  private target: HTMLElement | null = null;
  private files: DiffFile[] = [];
  /** Number cell currently showing the hover affordance, if any. */
  private hintCell: HTMLTableCellElement | null = null;
  private statusEl: HTMLElement | null = null;
  private summaryBtn: HTMLButtonElement | null = null;
  private summaryPanel: HTMLElement | null = null;
  private summaryList: HTMLElement | null = null;
  private summaryOpen = false;

  constructor(config: ReviewUIConfig = {}) {
    this.author = config.author ?? 'anonymous';
    this.onReviewChange = config.onReviewChange;
    this.revealLine = config.revealLine;
    this.store.onChange(() => {
      this.renderAll();
      this.onReviewChange?.(this.store.export());
    });
  }

  /** Attaches review interactions to every rendered file wrapper. */
  wire(target: HTMLElement, files: DiffFile[]): void {
    this.target = target;
    this.files = files;

    files.forEach(file => {
      const wrapper = target.querySelector<HTMLElement>(`#${getHtmlId(file)}`);
      if (wrapper === null) return;

      this.wireFileCommentButton(wrapper, file);
      this.wireLineCommentClicks(wrapper, file);
      this.wireLineCommentHints(wrapper, file);
    });
    this.renderAll();
  }

  /** Renders the export/import toolbar at the top of the diff container, plus the comment navigation panel. */
  wireToolbar(target: HTMLElement): void {
    const bar = document.createElement('div');
    bar.className = 'd2h-review-toolbar';

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.textContent = '导出评论';
    exportBtn.className = 'd2h-review-export-btn';
    exportBtn.addEventListener('click', () => {
      const json = this.store.export();
      const blob = new Blob([json], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'review.json';
      link.click();
      URL.revokeObjectURL(link.href);
      void navigator.clipboard
        ?.writeText(json)
        .then(() => null)
        .catch(() => null);
      exportBtn.textContent = '已导出 + 已复制';
      window.setTimeout(() => (exportBtn.textContent = '导出评论'), 1500);
    });

    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = 'application/json,.json';
    importInput.style.display = 'none';
    importInput.addEventListener('change', () => {
      const file = importInput.files?.[0];
      if (file === undefined) return;
      void file
        .text()
        .then(text => this.importReview(text))
        .catch(error => {
          this.showStatus(`导入失败：${(error as Error).message}`, 'error');
          return null;
        });
      importInput.value = '';
    });

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.textContent = '导入评论';
    importBtn.className = 'd2h-review-import-btn';
    importBtn.addEventListener('click', () => importInput.click());

    this.summaryBtn = document.createElement('button');
    this.summaryBtn.type = 'button';
    this.summaryBtn.className = 'd2h-review-summary-btn';
    this.summaryBtn.textContent = '💬 评论 0';
    this.summaryBtn.addEventListener('click', () => this.toggleSummary());

    this.statusEl = document.createElement('span');
    this.statusEl.className = 'd2h-review-status';
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.setAttribute('aria-live', 'polite');

    bar.appendChild(exportBtn);
    bar.appendChild(importBtn);
    bar.appendChild(importInput);
    bar.appendChild(this.summaryBtn);
    bar.appendChild(this.statusEl);
    target.insertBefore(bar, target.firstChild);

    this.buildSummaryPanel(target);
    this.renderSummary();
  }

  /**
   * Replaces the review with an imported JSON array and returns what happened
   * to every entry. Comments anchored to lines hidden by collapsed context are
   * revealed first, so an imported review is visible without hunting for it.
   * Throws on unparseable JSON; individual invalid entries are reported in the
   * returned report instead.
   */
  async importReview(json: string): Promise<ReviewImportReport> {
    const result = this.store.import(json);
    const comments = this.store.all();

    for (const comment of comments) {
      if (comment.lineNumber === undefined) continue;
      const file = this.files.find(candidate => anchorPath(candidate) === comment.filePath);
      if (file === undefined) continue;
      await this.revealLine?.(file, comment.side, comment.lineNumber);
    }

    this.renderAll();
    const placed = comments.filter(comment => this.placed.has(comment.id)).length;
    const unplaced = result.imported - placed;
    const report: ReviewImportReport = {
      ...result,
      placed,
      unplaced,
      message: importMessage(result, unplaced),
    };

    this.showStatus(report.message, unplaced > 0 || result.skipped > 0 ? 'warn' : 'ok');
    this.summaryOpen = true;
    this.renderSummary();
    return report;
  }

  exportReview(): string {
    return this.store.export();
  }

  private showStatus(message: string, kind: 'ok' | 'warn' | 'error'): void {
    if (this.statusEl === null) return;
    this.statusEl.textContent = message;
    this.statusEl.className = `d2h-review-status d2h-review-status-${kind}`;
  }

  private toggleSummary(): void {
    this.summaryOpen = !this.summaryOpen;
    this.renderSummary();
  }

  private buildSummaryPanel(target: HTMLElement): void {
    const panel = document.createElement('aside');
    panel.className = 'd2h-review-panel';
    panel.setAttribute('aria-label', '评论导航');

    const head = document.createElement('div');
    head.className = 'd2h-review-panel-head';

    const title = document.createElement('span');
    title.className = 'd2h-review-panel-title';
    title.textContent = '评论导航';

    const count = document.createElement('span');
    count.className = 'd2h-review-panel-count';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'd2h-review-panel-close';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭评论导航');
    close.addEventListener('click', () => this.toggleSummary());

    head.appendChild(title);
    head.appendChild(count);
    head.appendChild(close);

    const list = document.createElement('div');
    list.className = 'd2h-review-list';

    panel.appendChild(head);
    panel.appendChild(list);
    target.appendChild(panel);

    this.summaryPanel = panel;
    this.summaryList = list;
  }

  /** One entry per comment, grouped by file, next to the current total. */
  private renderSummary(): void {
    const comments = this.store.all();
    const byFile = new Map<string, Comment[]>();
    comments.forEach(comment => {
      const list = byFile.get(comment.filePath);
      if (list === undefined) byFile.set(comment.filePath, [comment]);
      else list.push(comment);
    });

    if (this.summaryBtn !== null) {
      this.summaryBtn.textContent = `💬 评论 ${comments.length}`;
      this.summaryBtn.classList.toggle('d2h-review-summary-btn-on', this.summaryOpen);
    }
    if (this.summaryPanel === null || this.summaryList === null) return;

    this.summaryPanel.classList.toggle('d2h-review-panel-open', this.summaryOpen);
    const count = this.summaryPanel.querySelector<HTMLElement>('.d2h-review-panel-count');
    if (count !== null) count.textContent = `${comments.length} 条 / ${byFile.size} 个文件`;

    this.summaryList.replaceChildren();
    if (comments.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'd2h-review-empty';
      empty.textContent = '暂无评论。悬停行号或点击行号即可添加。';
      this.summaryList.appendChild(empty);
      return;
    }

    byFile.forEach((list, filePath) => {
      const group = document.createElement('div');
      group.className = 'd2h-review-group';

      const head = document.createElement('div');
      head.className = 'd2h-review-group-head';
      head.textContent = filePath;

      const items = document.createElement('ul');
      items.className = 'd2h-review-items';
      sortComments(list).forEach(comment => items.appendChild(this.buildSummaryItem(comment)));

      const total = document.createElement('span');
      total.className = 'd2h-review-group-count';
      total.textContent = String(list.length);
      head.appendChild(total);

      group.appendChild(head);
      group.appendChild(items);
      this.summaryList!.appendChild(group);
    });
  }

  private buildSummaryItem(comment: Comment): HTMLElement {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd2h-review-item';

    const anchor = document.createElement('span');
    anchor.className = 'd2h-review-item-anchor';
    anchor.textContent = anchorLabel(comment);

    const text = document.createElement('span');
    text.className = 'd2h-review-item-text';
    text.textContent = comment.text;

    const author = document.createElement('span');
    author.className = 'd2h-review-item-author';
    author.textContent = comment.author;

    button.appendChild(anchor);
    button.appendChild(text);
    button.appendChild(author);
    button.addEventListener('click', () => void this.focusComment(comment.id));
    item.appendChild(button);
    return item;
  }

  /** Brings one comment into view, revealing its line first when it is collapsed. */
  private async focusComment(id: string): Promise<void> {
    const comment = this.store.all().find(candidate => candidate.id === id);
    if (comment === undefined) return;

    if (comment.lineNumber !== undefined && !this.placed.has(comment.id)) {
      const file = this.files.find(candidate => anchorPath(candidate) === comment.filePath);
      if (file !== undefined && (await this.revealLine?.(file, comment.side, comment.lineNumber)) === true) {
        this.renderAll();
      }
    }
    this.flashComment(id);
  }

  private flashComment(id: string): void {
    const card = this.findCard(id);
    if (card === null) return;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add('d2h-review-flash');
    window.setTimeout(() => card.classList.remove('d2h-review-flash'), 1500);
  }

  /** The visible card of one comment; side-by-side renders a hidden twin next to it. */
  private findCard(id: string): HTMLElement | null {
    if (this.target === null) return null;
    const cards = Array.from(this.target.querySelectorAll<HTMLElement>('.d2h-review-comment'));
    return cards.find(card => card.dataset.reviewId === id && card.closest('.d2h-review-twin') === null) ?? null;
  }

  private formatOf(wrapper: HTMLElement): Format {
    return wrapper.querySelector('.d2h-files-diff') !== null ? 'side-by-side' : 'line-by-line';
  }

  private wireFileCommentButton(wrapper: HTMLElement, file: DiffFile): void {
    const header = wrapper.querySelector<HTMLElement>('.d2h-file-header');
    if (header === null) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd2h-review-file-btn';
    button.textContent = '💬 文件评论';
    button.addEventListener('click', () => this.openFileEditor(header, file));
    header.appendChild(button);

    // Full-width panel below the header: as a header flex child it would be
    // squeezed into a narrow column.
    const panel = document.createElement('div');
    panel.className = 'd2h-review-file-panel';
    header.parentNode!.insertBefore(panel, header.nextSibling);
  }

  /** Delegated click handling so rows added later (expansion, re-renders) work too. */
  private wireLineCommentClicks(wrapper: HTMLElement, file: DiffFile): void {
    wrapper.addEventListener('click', event => {
      const cell = (event.target as HTMLElement).closest('td');
      if (cell === null) return;

      const anchor = this.resolveAnchor(wrapper, cell as HTMLTableCellElement);
      if (anchor === null) return;

      this.openLineEditor(anchor.row, file, anchor.lineNumber, anchor.side, anchor.twinBody);
    });
  }

  /**
   * Delegated hover handling: reveals the comment affordance in the number
   * gutter of the line under the pointer, so the click-to-comment behaviour is
   * discoverable. Rows revealed later by context expansion work too.
   */
  private wireLineCommentHints(wrapper: HTMLElement, file: DiffFile): void {
    wrapper.addEventListener('mouseover', event => {
      const target = event.target as HTMLElement;
      const row = target.closest('tr');
      if (row !== null && row === this.hintCell?.closest('tr')) {
        // Same line: only the ghost / solid state follows the pointer.
        this.setHintSolid(this.isOverNumbers(target));
        return;
      }

      this.hideHint();
      if (row === null) return;

      const cell = row.querySelector<HTMLTableCellElement>('.d2h-code-linenumber, .d2h-code-side-linenumber');
      if (cell === null || this.resolveAnchor(wrapper, cell) === null) return;

      this.showHint(cell, wrapper, file, this.isOverNumbers(target));
    });

    wrapper.addEventListener('mouseleave', () => this.hideHint());
  }

  /** True while the pointer is on the number cell itself rather than on the code. */
  private isOverNumbers(target: HTMLElement): boolean {
    const cell = target.closest('td');
    if (cell === null) return false;
    return cell.classList.contains('d2h-code-linenumber') || cell.classList.contains('d2h-code-side-linenumber');
  }

  private showHint(cell: HTMLTableCellElement, wrapper: HTMLElement, file: DiffFile, solid: boolean): void {
    const hint = this.ensureHint(cell, wrapper, file);
    this.hintCell = cell;
    // Read a layout property so a button inserted in this same tick animates in
    // instead of popping into place.
    void hint.offsetWidth;
    hint.classList.add('d2h-review-hint-on');
    hint.classList.toggle('d2h-review-hint-solid', solid);
  }

  private setHintSolid(solid: boolean): void {
    this.hintCell?.querySelector('.d2h-review-hint')?.classList.toggle('d2h-review-hint-solid', solid);
  }

  private hideHint(): void {
    this.hintCell?.querySelector('.d2h-review-hint')?.classList.remove('d2h-review-hint-on');
    this.hintCell = null;
  }

  /** Creates the affordance once per number cell, on first hover. */
  private ensureHint(cell: HTMLTableCellElement, wrapper: HTMLElement, file: DiffFile): HTMLButtonElement {
    const existing = cell.querySelector<HTMLButtonElement>('.d2h-review-hint');
    if (existing !== null) return existing;

    const hint = document.createElement('button');
    hint.type = 'button';
    hint.className = 'd2h-review-hint';
    hint.title = '添加行评论';
    hint.setAttribute('aria-label', '添加行评论');
    hint.textContent = '💬';
    hint.addEventListener('click', event => {
      event.preventDefault();
      // Keep the wrapper's click handler from opening a second editor.
      event.stopPropagation();
      const anchor = this.resolveAnchor(wrapper, cell);
      this.hideHint();
      if (anchor === null) return;

      // A marker over existing comments jumps to them instead of adding one.
      const existingComments = this.commentsAt(file, anchor.lineNumber, anchor.side);
      if (existingComments.length > 0) this.flashComment(existingComments[0].id);
      else this.openLineEditor(anchor.row, file, anchor.lineNumber, anchor.side, anchor.twinBody);
    });

    cell.appendChild(hint);
    return hint;
  }

  /** Maps a line-number cell to the comment anchor it stands for, or `null` for filler and hunk header rows. */
  private resolveAnchor(
    wrapper: HTMLElement,
    cell: HTMLTableCellElement,
  ): { row: HTMLTableRowElement; lineNumber: number; side: CommentSide; twinBody: Element | null } | null {
    const isSideCell = cell.classList.contains('d2h-code-side-linenumber');
    const isLineCell = cell.classList.contains('d2h-code-linenumber');
    if (!isSideCell && !isLineCell) return null;

    const row = cell.closest('tr');
    if (row === null || row.querySelector('.d2h-review-editor') !== null) return null;

    let side: CommentSide;
    let lineNumber: number;
    if (isSideCell) {
      const tables = wrapper.querySelectorAll('.d2h-files-diff table');
      side = tables.length === 2 && cell.closest('table') === tables[0] ? 'old' : 'new';
      lineNumber = this.cellLineNumber(cell);
    } else {
      const num1 = row.querySelector<HTMLElement>('.line-num1')?.textContent ?? '';
      const num2 = row.querySelector<HTMLElement>('.line-num2')?.textContent ?? '';
      if (num2 !== '') {
        side = 'new';
        lineNumber = Number(num2);
      } else if (num1 !== '') {
        side = 'old';
        lineNumber = Number(num1);
      } else {
        return null; // hunk header row
      }
    }
    if (!Number.isInteger(lineNumber) || lineNumber < 1) return null; // filler / header row

    let twinBody: Element | null = null;
    if (isSideCell) {
      const bodies = wrapper.querySelectorAll('.d2h-files-diff table > tbody');
      const own = cell.closest('tbody');
      if (bodies.length === 2 && own !== null) {
        twinBody = own === bodies[0] ? bodies[1] : bodies[0];
      }
    }

    return { row, lineNumber, side, twinBody };
  }

  private openLineEditor(
    row: HTMLTableRowElement,
    file: DiffFile,
    lineNumber: number,
    side: CommentSide,
    twinBody: Element | null,
  ): void {
    // Repeated clicks on the same line must not stack editors.
    const next = row.nextElementSibling;
    if (next !== null && next.classList.contains('d2h-review-editor')) {
      next.querySelector('textarea')?.focus();
      return;
    }

    const tbody = row.parentNode as Element;
    const index = Array.from(tbody.children).indexOf(row);

    let twinRow: HTMLTableRowElement | null = null;
    const removeEditor = (): void => {
      editorRow.remove();
      twinRow?.remove();
    };

    const editorRow = this.buildEditor(text => {
      if (text !== '') {
        // Own the comment BEFORE it hits the store: the store notifies
        // synchronously during add, and the first render decides whether the
        // edit/delete buttons appear.
        const id = newCommentId();
        this.sessionOwned.add(id);
        this.store.addLineComment({ filePath: anchorPath(file), lineNumber, side, author: this.author, text }, id);
      }
      removeEditor();
    }, removeEditor);

    tbody.insertBefore(editorRow, row.nextSibling);

    if (twinBody !== null) {
      twinRow = editorRow.cloneNode(true) as HTMLTableRowElement;
      twinRow.classList.add('d2h-review-twin');
      twinRow.style.visibility = 'hidden';
      const twinAnchor = twinBody.children[index] ?? null;
      twinBody.insertBefore(twinRow, twinAnchor === null ? null : twinAnchor.nextSibling);
      const textarea = editorRow.querySelector('textarea');
      const twinTextarea = twinRow.querySelector('textarea');
      textarea?.addEventListener('input', () => {
        if (twinTextarea !== null) twinTextarea.value = textarea.value;
      });
    }

    editorRow.querySelector('textarea')?.focus();
  }

  private openFileEditor(header: HTMLElement, file: DiffFile): void {
    const panel = header.parentNode?.querySelector<HTMLElement>(`:scope > .d2h-review-file-panel`);
    if (panel === null || panel === undefined || panel.querySelector('.d2h-review-editor') !== null) return;

    const editor = this.buildEditor(
      text => {
        if (text !== '') {
          const id = newCommentId();
          this.sessionOwned.add(id);
          this.store.addFileComment({ filePath: anchorPath(file), author: this.author, text }, id);
        }
        editor.remove();
      },
      () => editor.remove(),
    );
    panel.appendChild(editor);
    editor.querySelector('textarea')?.focus();
  }

  private buildEditor(save: (text: string) => void, cancel: () => void): HTMLTableRowElement {
    const container = document.createElement('tr');
    container.className = 'd2h-review-editor';

    const body = document.createElement('td');
    body.colSpan = 2;
    body.className = 'd2h-review-editor-body';

    const textarea = document.createElement('textarea');
    textarea.className = 'd2h-review-input';
    textarea.rows = 3;

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = '保存';
    saveBtn.className = 'd2h-review-save';
    saveBtn.addEventListener('click', () => save(textarea.value.trim()));

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = '取消';
    cancelBtn.className = 'd2h-review-cancel';
    cancelBtn.addEventListener('click', () => cancel());

    body.appendChild(textarea);
    body.appendChild(saveBtn);
    body.appendChild(cancelBtn);
    container.appendChild(body);
    return container;
  }

  private renderAll(): void {
    if (this.target === null) return;
    this.placed.clear();
    this.target.querySelectorAll('.d2h-review-file-panel').forEach(panel => (panel.innerHTML = ''));
    this.target.querySelectorAll('tr.d2h-review-comment-row').forEach(row => row.remove());

    this.target.querySelectorAll<HTMLElement>('.d2h-file-wrapper').forEach(wrapper => {
      const file = this.files.find(f => getHtmlId(f) === wrapper.id);
      if (file === undefined) return;

      const format = this.formatOf(wrapper);
      this.renderFileComments(wrapper, file);
      this.renderLineComments(wrapper, file, format);
      this.markCommentedLines(wrapper, file, format);
      this.renderFileButton(wrapper, file);
    });

    this.renderSummary();
  }

  private renderFileComments(wrapper: HTMLElement, file: DiffFile): void {
    const panel = wrapper.querySelector<HTMLElement>('.d2h-review-file-panel');
    if (panel === null) return;

    this.store
      .commentsForFile(anchorPath(file))
      .filter(comment => comment.lineNumber === undefined)
      .forEach(comment => {
        panel.appendChild(this.buildCommentCard(comment));
        this.placed.add(comment.id);
      });
  }

  /** The file header button carries the comment count, so a commented file stands out. */
  private renderFileButton(wrapper: HTMLElement, file: DiffFile): void {
    const button = wrapper.querySelector<HTMLElement>('.d2h-review-file-btn');
    if (button === null) return;
    const count = this.store.commentsForFile(anchorPath(file)).length;
    button.textContent = count === 0 ? '💬 文件评论' : `💬 文件评论 (${count})`;
    button.classList.toggle('d2h-review-file-btn-on', count > 0);
  }

  /**
   * Leaves a permanent comment marker in the number gutter of every commented
   * line, so comments are visible without hovering.
   */
  private markCommentedLines(wrapper: HTMLElement, file: DiffFile, format: Format): void {
    wrapper
      .querySelectorAll('.d2h-review-hint-marked')
      .forEach(hint => hint.classList.remove('d2h-review-hint-marked'));

    const counts = new Map<HTMLTableCellElement, number>();
    this.store
      .commentsForFile(anchorPath(file))
      .filter(comment => comment.lineNumber !== undefined)
      .forEach(comment => {
        const cell = this.findAnchorCell(wrapper, comment, format);
        if (cell !== null) counts.set(cell, (counts.get(cell) ?? 0) + 1);
      });

    counts.forEach((count, cell) => {
      const hint = this.ensureHint(cell, wrapper, file);
      hint.classList.add('d2h-review-hint-marked');
      hint.textContent = count === 1 ? '💬' : `💬${count}`;
      hint.title = count === 1 ? '查看评论' : `查看 ${count} 条评论`;
      hint.setAttribute('aria-label', hint.title);
    });
  }

  /** The rendered number cell of one line comment, or null when its line is not rendered. */
  private findAnchorCell(wrapper: HTMLElement, comment: Comment, format: Format): HTMLTableCellElement | null {
    if (format === 'side-by-side') {
      const bodies = wrapper.querySelectorAll('.d2h-files-diff table > tbody');
      if (bodies.length !== 2) return null;
      const body = comment.side === 'old' ? bodies[0] : bodies[1];
      const rows = Array.from(body.children) as HTMLTableRowElement[];
      const row = rows.find(candidate => this.sideRowMatches(candidate, comment));
      return row?.querySelector<HTMLTableCellElement>('td.d2h-code-side-linenumber') ?? null;
    }

    const rows = Array.from(wrapper.querySelectorAll('tr')) as HTMLTableRowElement[];
    const row = rows.find(candidate => this.rowMatches(candidate, comment));
    return row?.querySelector<HTMLTableCellElement>('td.d2h-code-linenumber') ?? null;
  }

  private commentsAt(file: DiffFile, lineNumber: number, side: CommentSide): Comment[] {
    return this.store
      .commentsForFile(anchorPath(file))
      .filter(comment => comment.lineNumber === lineNumber && comment.side === side);
  }

  private renderLineComments(wrapper: HTMLElement, file: DiffFile, format: Format): void {
    const lineComments = this.store.commentsForFile(anchorPath(file)).filter(c => c.lineNumber !== undefined);
    if (lineComments.length === 0) return;

    if (format === 'side-by-side') {
      const bodies = wrapper.querySelectorAll('.d2h-files-diff table > tbody');
      if (bodies.length !== 2) return;
      const leftBody = bodies[0];
      const rightBody = bodies[1];

      lineComments.forEach(comment => {
        const target = comment.side === 'old' ? leftBody : rightBody;
        const other = comment.side === 'old' ? rightBody : leftBody;

        const rows = Array.from(target.children) as HTMLTableRowElement[];
        const idx = rows.findIndex(row => this.sideRowMatches(row, comment));
        if (idx === -1) return;

        target.insertBefore(this.buildCommentRow(comment, false), rows[idx + 1] ?? null);
        const otherRows = Array.from(other.children);
        other.insertBefore(this.buildCommentRow(comment, true), otherRows[idx + 1] ?? null);
        this.placed.add(comment.id);
      });
      return;
    }

    const rows = Array.from(wrapper.querySelectorAll('tr'));
    lineComments.forEach(comment => {
      const targetRow = rows.find(row => this.rowMatches(row, comment));
      if (targetRow === undefined) return;
      // Stack comments of the same line in order.
      let insertAfter = targetRow;
      while (insertAfter.nextElementSibling?.classList.contains('d2h-review-comment-row')) {
        insertAfter = insertAfter.nextElementSibling as HTMLTableRowElement;
      }
      insertAfter.parentNode!.insertBefore(this.buildCommentRow(comment, false), insertAfter.nextSibling);
      this.placed.add(comment.id);
    });
  }

  private rowMatches(row: HTMLTableRowElement, comment: Comment): boolean {
    if (row.querySelector('.d2h-review-editor') !== null) return false;
    const selector = comment.side === 'new' ? '.line-num2' : '.line-num1';
    const num = row.querySelector<HTMLElement>(selector)?.textContent ?? '';
    return num !== '' && Number(num) === comment.lineNumber;
  }

  private sideRowMatches(row: HTMLTableRowElement, comment: Comment): boolean {
    if (row.querySelector('.d2h-review-editor') !== null) return false;
    const cell = row.querySelector<HTMLTableCellElement>('td.d2h-code-side-linenumber');
    if (cell === null) return false;
    return this.cellLineNumber(cell) === comment.lineNumber;
  }

  /**
   * Line number printed by a number cell. Only the cell's own text nodes are
   * read: the comment affordance lives inside the cell too, and its icon must
   * not leak into the number.
   */
  private cellLineNumber(cell: HTMLTableCellElement): number {
    const own = Array.from(cell.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent ?? '')
      .join('')
      .trim();
    return own === '' ? NaN : Number(own);
  }

  private buildCommentRow(comment: Comment, hidden: boolean): HTMLTableRowElement {
    const row = document.createElement('tr');
    row.className = 'd2h-review-comment-row' + (hidden ? ' d2h-review-twin' : '');
    if (hidden) row.style.visibility = 'hidden';
    const cell = document.createElement('td');
    cell.colSpan = 2;
    cell.className = 'd2h-review-comment-cell';
    cell.appendChild(this.buildCommentCard(comment));
    row.appendChild(cell);
    return row;
  }

  private buildCommentCard(comment: Comment): HTMLElement {
    const card = document.createElement('div');
    card.className = 'd2h-review-comment';
    card.dataset.reviewId = comment.id;

    const meta = document.createElement('div');
    meta.className = 'd2h-review-meta';

    const author = document.createElement('span');
    author.className = 'd2h-review-author';
    author.textContent = comment.author;

    const anchor = document.createElement('span');
    anchor.className = 'd2h-review-anchor';
    anchor.textContent = anchorLabel(comment);

    meta.appendChild(author);
    meta.appendChild(anchor);

    const text = document.createElement('div');
    text.className = 'd2h-review-text';
    text.textContent = comment.text;

    card.appendChild(meta);
    card.appendChild(text);

    if (this.sessionOwned.has(comment.id)) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.textContent = '删除';
      deleteBtn.className = 'd2h-review-delete';
      deleteBtn.addEventListener('click', () => this.store.deleteComment(comment.id));

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = '编辑';
      editBtn.className = 'd2h-review-edit';
      editBtn.addEventListener('click', () => {
        const input = document.createElement('textarea');
        input.className = 'd2h-review-input';
        input.value = comment.text;
        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.textContent = '保存';
        confirmBtn.addEventListener('click', () => {
          if (input.value.trim() !== '') this.store.editComment(comment.id, input.value.trim());
        });
        text.replaceChildren(input, confirmBtn);
      });

      const actions = document.createElement('div');
      actions.className = 'd2h-review-actions';
      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);
      card.appendChild(actions);
    }

    return card;
  }
}

function anchorPath(file: DiffFile): string {
  return file.newName === '/dev/null' ? file.oldName : file.newName;
}

/** Where a comment sits, for card and navigation labels. */
function anchorLabel(comment: Comment): string {
  if (comment.lineNumber === undefined) return '文件评论';
  return `第 ${comment.lineNumber} 行 · ${comment.side === 'old' ? '旧' : '新'}`;
}

/** File comments first, then line comments in line order, like `commentsForFile`. */
function sortComments(comments: Comment[]): Comment[] {
  return [...comments].sort((a, b) => {
    if (a.lineNumber === undefined || b.lineNumber === undefined) {
      if (a.lineNumber === undefined && b.lineNumber === undefined) return 0;
      return a.lineNumber === undefined ? -1 : 1;
    }
    return a.lineNumber - b.lineNumber || b.side!.localeCompare(a.side!);
  });
}

/** One-line summary of an import, including everything that could not be shown. */
function importMessage(result: ReviewImportResult, unplaced: number): string {
  if (result.total === 0) return '导入完成：文件里没有评论';
  const parts = [`导入完成：成功 ${result.imported} / ${result.total} 条`];
  if (result.skipped > 0) parts.push(`${result.skipped} 条格式无效`);
  if (unplaced > 0) parts.push(`${unplaced} 条在 diff 中找不到位置`);
  return parts.join('，');
}
