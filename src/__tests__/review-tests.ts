import { newCommentId, ReviewStore } from '../review';

describe('review', () => {
  it('adds a line comment anchored to the new line number and exposes it in export JSON', () => {
    const store = new ReviewStore();
    store.addLineComment({
      filePath: 'src/app.ts',
      lineNumber: 3,
      side: 'new',
      author: 'alice',
      text: 'use a const here',
    });

    const exported = JSON.parse(store.export());
    expect(exported[0]).toMatchObject({
      filePath: 'src/app.ts',
      lineNumber: 3,
      side: 'new',
      author: 'alice',
      text: 'use a const here',
    });
    expect(exported[0].id).toBeTruthy();
  });

  it('anchors deleted lines to the old line number', () => {
    const store = new ReviewStore();
    store.addLineComment({ filePath: 'src/app.ts', lineNumber: 2, side: 'old', author: 'bob', text: 'dropped?' });

    const exported = JSON.parse(store.export());
    expect(exported[0]).toMatchObject({ lineNumber: 2, side: 'old' });
  });

  it('adds a file comment without a line anchor', () => {
    const store = new ReviewStore();
    store.addFileComment({ filePath: 'src/app.ts', author: 'carol', text: 'lgtm except naming' });

    const exported = JSON.parse(store.export());
    expect(exported[0]).toMatchObject({ filePath: 'src/app.ts', text: 'lgtm except naming' });
    expect(exported[0].lineNumber).toBeUndefined();
    expect(exported[0].side).toBeUndefined();
  });

  it('stamps each comment with an id and editable timestamp', () => {
    const store = new ReviewStore();
    const comment = store.addLineComment({
      filePath: 'src/app.ts',
      lineNumber: 1,
      side: 'new',
      author: 'alice',
      text: 'x',
    });

    expect(comment.id).toBeTruthy();
    expect(typeof comment.createdAt).toBe('number');
  });

  it('edits and deletes only the targeted comment', () => {
    const store = new ReviewStore();
    const first = store.addLineComment({
      filePath: 'src/app.ts',
      lineNumber: 1,
      side: 'new',
      author: 'alice',
      text: 'first',
    });
    const second = store.addLineComment({
      filePath: 'src/app.ts',
      lineNumber: 2,
      side: 'new',
      author: 'alice',
      text: 'second',
    });

    store.editComment(second.id, 'second (edited)');
    store.deleteComment(first.id);

    const exported = JSON.parse(store.export());
    expect(exported).toHaveLength(1);
    expect(exported[0].text).toBe('second (edited)');
  });

  it('imports a previously exported review and round-trips it', () => {
    const store = new ReviewStore();
    store.addLineComment({ filePath: 'src/app.ts', lineNumber: 3, side: 'new', author: 'alice', text: 'note' });

    const other = new ReviewStore();
    other.import(store.export());

    expect(other.export()).toBe(store.export());
  });

  it('notifies on every mutation', () => {
    const store = new ReviewStore();
    const changes: number[] = [];
    store.onChange(() => changes.push(JSON.parse(store.export()).length));

    const comment = store.addLineComment({
      filePath: 'src/app.ts',
      lineNumber: 1,
      side: 'new',
      author: 'a',
      text: 'x',
    });
    store.editComment(comment.id, 'y');
    store.deleteComment(comment.id);

    expect(changes).toEqual([1, 1, 0]);
  });

  it('lists file comments first, then line comments sorted by line number and side', () => {
    const store = new ReviewStore();
    store.addLineComment({ filePath: 'src/app.ts', lineNumber: 5, side: 'new', author: 'a', text: 'later line' });
    store.addLineComment({ filePath: 'src/app.ts', lineNumber: 2, side: 'new', author: 'a', text: 'new line 2' });
    store.addFileComment({ filePath: 'src/app.ts', author: 'a', text: 'file level' });
    store.addLineComment({ filePath: 'src/app.ts', lineNumber: 2, side: 'old', author: 'a', text: 'old line 2' });
    store.addLineComment({ filePath: 'src/other.ts', lineNumber: 1, side: 'new', author: 'a', text: 'other file' });

    const comments = store.commentsForFile('src/app.ts');
    expect(comments.map(c => c.text)).toEqual(['file level', 'old line 2', 'new line 2', 'later line']);
  });

  it('returns an empty list for a file without comments', () => {
    const store = new ReviewStore();
    expect(store.commentsForFile('src/none.ts')).toEqual([]);
  });

  it('rejects malformed review JSON on import', () => {
    const store = new ReviewStore();
    expect(() => store.import('"not an array"')).toThrow('Invalid review JSON: expected an array of comments');
    expect(() => store.import('{oops')).toThrow(/^Invalid review JSON: /);
  });

  it('imports valid entries and reports counts and reasons for the rest', () => {
    const store = new ReviewStore();
    const result = store.import(
      JSON.stringify([
        { filePath: 'src/app.ts', lineNumber: 3, side: 'new', author: 'alice', text: '  line note  ' },
        { filePath: 'src/app.ts', text: 'file note' },
        null,
        [1],
        { lineNumber: 1, side: 'new', text: 'no filePath' },
        { filePath: 'src/app.ts', text: 42 },
        { filePath: 'src/app.ts', lineNumber: 0, side: 'new', text: 'bad line' },
        { filePath: 'src/app.ts', lineNumber: 2.5, side: 'new', text: 'fractional line' },
        { filePath: 'src/app.ts', lineNumber: 2, text: 'no side' },
        { filePath: 'src/app.ts', lineNumber: 4, side: 'new', text: 'kept' },
      ]),
    );

    expect(result.total).toBe(10);
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(7);
    expect(result.errors).toHaveLength(7);
    expect(result.errors[0]).toContain('#3');
    expect(result.errors[1]).toContain('#4');

    expect(store.all()).toHaveLength(3);
    expect(store.all()[0]).toMatchObject({ filePath: 'src/app.ts', text: 'line note', author: 'alice' });
    expect(store.all()[0].id).toBeTruthy();
    expect(store.all()[0].createdAt).toEqual(expect.any(Number));
    // A missing author falls back to `anonymous`; file comments have no line anchor.
    expect(store.all()[1]).toMatchObject({ author: 'anonymous', lineNumber: undefined });
    expect(store.all()[2]).toMatchObject({ author: 'anonymous', text: 'kept' });
  });

  it('keeps the imported id when present and reassigns duplicated ones', () => {
    const store = new ReviewStore();
    store.import(
      JSON.stringify([
        { id: 'keep-me', filePath: 'src/app.ts', author: 'a', text: 'first' },
        { id: 'keep-me', filePath: 'src/app.ts', author: 'a', text: 'second' },
      ]),
    );

    const ids = store.all().map(comment => comment.id);
    expect(ids[0]).toBe('keep-me');
    expect(ids[1]).not.toBe('keep-me');
    expect(new Set(ids).size).toBe(2);
  });

  it('hands out comment copies from all()', () => {
    const store = new ReviewStore();
    store.addFileComment({ filePath: 'src/app.ts', author: 'a', text: 'x' });

    const comments = store.all();
    comments.length = 0;
    expect(store.all()).toHaveLength(1);
  });

  it('reports a miss when editing or deleting an unknown comment', () => {
    const store = new ReviewStore();
    expect(store.editComment('nope', 'x')).toBe(false);
    expect(store.deleteComment('nope')).toBe(false);
  });

  it('accepts a caller-owned comment id', () => {
    const store = new ReviewStore();
    const id = newCommentId();
    store.addLineComment({ filePath: 'src/app.ts', lineNumber: 1, side: 'new', author: 'a', text: 'x' }, id);

    expect(store.all()[0].id).toBe(id);
  });
});
