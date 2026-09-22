import { ReviewStore } from '../review';

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
  });
});
