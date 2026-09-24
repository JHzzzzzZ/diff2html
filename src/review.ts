export type CommentSide = 'old' | 'new';

export interface LineCommentInput {
  filePath: string;
  lineNumber: number;
  side: CommentSide;
  author: string;
  text: string;
}

export interface FileCommentInput {
  filePath: string;
  author: string;
  text: string;
}

export interface Comment extends LineCommentInput {
  id: string;
  createdAt: number;
}

export type ExportedComment = Comment;

/**
 * Outcome of one `ReviewStore.import` call. `total` counts every entry of the
 * imported array, `imported` the entries that passed validation and were
 * stored, `skipped` the rest; `errors` carries one reason per skipped entry,
 * in import order.
 */
export interface ReviewImportResult {
  total: number;
  imported: number;
  skipped: number;
  errors: string[];
}

let nextId = 0;

/** Generates a fresh unique comment id; pre-generate one to own the comment before it is added. */
export function newCommentId(): string {
  nextId += 1;
  return `c${Date.now().toString(36)}-${nextId}`;
}

type ChangeListener = () => void;

/**
 * In-memory store for review comments, serializable to and from plain JSON.
 * Line comments are anchored to (filePath, lineNumber, side) so they survive
 * context expansion; file comments are anchored to filePath only.
 */
export class ReviewStore {
  private comments: Comment[] = [];
  private listeners: ChangeListener[] = [];

  addLineComment(input: LineCommentInput, id?: string): Comment {
    return this.add({ ...input }, id);
  }

  addFileComment(input: FileCommentInput, id?: string): Comment {
    return this.add(
      {
        ...input,
        lineNumber: undefined as unknown as number,
        side: undefined as unknown as CommentSide,
      },
      id,
    );
  }

  editComment(id: string, text: string): boolean {
    const comment = this.comments.find(c => c.id === id);
    if (!comment) return false;
    comment.text = text;
    this.notify();
    return true;
  }

  deleteComment(id: string): boolean {
    const before = this.comments.length;
    this.comments = this.comments.filter(c => c.id !== id);
    if (this.comments.length === before) return false;
    this.notify();
    return true;
  }

  /** Every stored comment, in insertion order. */
  all(): Comment[] {
    return [...this.comments];
  }

  /** Comments for one file; line comments sorted by (lineNumber, side), file comments first. */
  commentsForFile(filePath: string): Comment[] {
    const file = this.comments.filter(c => c.filePath === filePath && c.lineNumber === undefined);
    const lines = this.comments
      .filter(c => c.filePath === filePath && c.lineNumber !== undefined)
      .sort((a, b) => a.lineNumber! - b.lineNumber! || b.side!.localeCompare(a.side!));
    return [...file, ...lines];
  }

  export(): string {
    return JSON.stringify(this.comments);
  }

  /**
   * Replaces the stored comments with the entries of a review JSON array.
   * Malformed JSON throws; individual entries that fail validation are
   * skipped and reported instead of failing the whole import.
   */
  import(json: string): ReviewImportResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      throw new Error(`Invalid review JSON: ${(error as Error).message}`);
    }
    if (!Array.isArray(parsed)) throw new Error('Invalid review JSON: expected an array of comments');

    const accepted: Comment[] = [];
    const errors: string[] = [];
    parsed.forEach((raw, index) => {
      const normalized = normalizeComment(raw);
      if (typeof normalized === 'string') errors.push(`#${index + 1}: ${normalized}`);
      else accepted.push(normalized);
    });

    // Two entries sharing an id would make edit/delete ambiguous.
    const ids = new Set<string>();
    accepted.forEach(comment => {
      if (ids.has(comment.id)) comment.id = newCommentId();
      ids.add(comment.id);
    });

    this.comments = accepted;
    this.notify();
    return { total: parsed.length, imported: accepted.length, skipped: errors.length, errors };
  }

  onChange(listener: ChangeListener): void {
    this.listeners.push(listener);
  }

  private add(partial: LineCommentInput, id?: string): Comment {
    const comment: Comment = { id: id ?? newCommentId(), createdAt: Date.now(), ...partial };
    this.comments.push(comment);
    this.notify();
    return comment;
  }

  private notify(): void {
    this.listeners.forEach(l => l());
  }
}

/**
 * Turns one untrusted imported entry into a comment, or returns the reason it
 * cannot be one. Missing ids and timestamps are filled in, and a missing
 * author falls back to `anonymous`; a missing file path, text, line number or
 * side is a rejection because the comment could not be anchored. File comments
 * are the entries without a line number.
 */
function normalizeComment(raw: unknown): Comment | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object';

  const item = raw as Partial<Comment>;
  if (typeof item.filePath !== 'string' || item.filePath === '') return 'missing filePath';

  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (text === '') return 'missing text';

  const hasLine = item.lineNumber !== undefined && item.lineNumber !== null;
  if (hasLine) {
    if (typeof item.lineNumber !== 'number' || !Number.isInteger(item.lineNumber) || item.lineNumber < 1) {
      return 'invalid lineNumber';
    }
    if (item.side !== 'old' && item.side !== 'new') return 'lineNumber without a valid side';
  }

  return {
    id: typeof item.id === 'string' && item.id !== '' ? item.id : newCommentId(),
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    filePath: item.filePath,
    lineNumber: hasLine ? (item.lineNumber as number) : (undefined as unknown as number),
    side: hasLine ? (item.side as CommentSide) : (undefined as unknown as CommentSide),
    author: typeof item.author === 'string' && item.author !== '' ? item.author : 'anonymous',
    text,
  };
}
