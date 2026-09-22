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

  import(json: string): void {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error('Invalid review JSON: expected an array of comments');
    this.comments = parsed;
    this.notify();
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
