import { DiffFile } from '../../types';
import { getHtmlId } from '../../render-utils';
import { newCommentId, Comment, CommentSide, ReviewStore } from '../../review';

export interface ReviewUIConfig {
  author?: string;
  onReviewChange?: (reviewJson: string) => void;
}

type Format = 'line-by-line' | 'side-by-side';

/**
 * Wires review comments into a rendered diff: click a line's number cell to
 * comment on that line, or the header button to comment on the whole file.
 * Comments are anchored to (filePath, lineNumber, side) and survive context
 * expansion. In side-by-side mode, rows inserted into one table are mirrored
 * by a hidden twin row in the other table so both sides stay row-aligned.
 */
export class ReviewUI {
  readonly store = new ReviewStore();
  private readonly author: string;
  private readonly onReviewChange?: (reviewJson: string) => void;
  private readonly sessionOwned = new Set<string>();
  private target: HTMLElement | null = null;
  private files: DiffFile[] = [];

  constructor(config: ReviewUIConfig = {}) {
    this.author = config.author ?? 'anonymous';
    this.onReviewChange = config.onReviewChange;
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
    });
    this.renderAll();
  }

  /** Renders the export/import toolbar at the top of the diff container. */
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
        .then(text => {
          try {
            this.importReview(text);
          } catch (error) {
            alert(`导入失败: ${(error as Error).message}`);
          }
          return null;
        })
        .catch(() => null);
      importInput.value = '';
    });

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.textContent = '导入评论';
    importBtn.className = 'd2h-review-import-btn';
    importBtn.addEventListener('click', () => importInput.click());

    bar.appendChild(exportBtn);
    bar.appendChild(importBtn);
    bar.appendChild(importInput);
    target.insertBefore(bar, target.firstChild);
  }

  importReview(json: string): void {
    this.store.import(json);
  }

  exportReview(): string {
    return this.store.export();
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

      const isSideCell = cell.classList.contains('d2h-code-side-linenumber');
      const isLineCell = cell.classList.contains('d2h-code-linenumber');
      if (!isSideCell && !isLineCell) return;

      const row = cell.closest('tr');
      if (row === null || row.querySelector('.d2h-review-editor') !== null) return;

      let side: CommentSide;
      let lineNumber: number;
      if (isSideCell) {
        const tables = wrapper.querySelectorAll('.d2h-files-diff table');
        side = tables.length === 2 && cell.closest('table') === tables[0] ? 'old' : 'new';
        lineNumber = Number(cell.textContent?.trim());
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
          return; // hunk header row
        }
      }
      if (!Number.isInteger(lineNumber) || lineNumber < 1) return; // filler / header row

      let twinBody: Element | null = null;
      if (isSideCell) {
        const bodies = wrapper.querySelectorAll('.d2h-files-diff table > tbody');
        const own = cell.closest('tbody');
        if (bodies.length === 2 && own !== null) {
          twinBody = own === bodies[0] ? bodies[1] : bodies[0];
        }
      }

      this.openLineEditor(row, file, lineNumber, side, twinBody);
    });
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
    this.target.querySelectorAll('.d2h-review-file-panel').forEach(panel => (panel.innerHTML = ''));
    this.target.querySelectorAll('tr.d2h-review-comment-row').forEach(row => row.remove());

    this.target.querySelectorAll<HTMLElement>('.d2h-file-wrapper').forEach(wrapper => {
      const file = this.files.find(f => getHtmlId(f) === wrapper.id);
      if (file === undefined) return;

      this.renderFileComments(wrapper, file);
      this.renderLineComments(wrapper, file, this.formatOf(wrapper));
    });
  }

  private renderFileComments(wrapper: HTMLElement, file: DiffFile): void {
    const panel = wrapper.querySelector<HTMLElement>('.d2h-review-file-panel');
    if (panel === null) return;

    this.store
      .commentsForFile(anchorPath(file))
      .filter(comment => comment.lineNumber === undefined)
      .forEach(comment => panel.appendChild(this.buildCommentCard(comment)));
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
    const num = row.querySelector('td.d2h-code-side-linenumber')?.textContent?.trim() ?? '';
    return num !== '' && Number(num) === comment.lineNumber;
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

    const meta = document.createElement('div');
    meta.className = 'd2h-review-meta';
    meta.textContent = `${comment.author}`;

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
