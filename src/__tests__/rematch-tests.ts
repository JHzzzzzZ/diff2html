import { levenshtein, newDistanceFn, newMatcherFn } from '../rematch';

describe('levenshtein', () => {
  it('is the length of the other string when one side is empty', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('counts substitutions, insertions and deletions', () => {
    expect(levenshtein('const a = 1;', 'const a = 1;')).toBe(0);
    expect(levenshtein('const a = 1;', 'const b = 1;')).toBe(1);
    expect(levenshtein('let a = 1;', 'let a = 12;')).toBe(1);
    expect(levenshtein('const a = 1;', 'a = 1;')).toBe(6);
  });
});

describe('newDistanceFn', () => {
  it('normalizes the distance by the combined length of both lines', () => {
    const distance = newDistanceFn<string>(value => value);

    expect(distance('abc', 'abc')).toBe(0);
    expect(distance('abc', 'abd')).toBeCloseTo(1 / 6);
  });

  it('ignores the indentation around the compared lines', () => {
    const distance = newDistanceFn<string>(value => value);

    expect(distance('    abc', 'abc   ')).toBe(0);
  });
});

describe('newMatcherFn', () => {
  it('groups every line exactly once, keeping the original order', () => {
    const matcher = newMatcherFn(newDistanceFn<string>(value => value));
    const oldLines = ['const a = 1;', 'const b = 2;', 'const c = 3;'];
    const newLines = ['const a = 1;', 'const c = 3;', 'const d = 4;'];

    const groups = matcher(oldLines, newLines);

    expect(groups.flatMap(([oldSide]) => oldSide)).toEqual(oldLines);
    expect(groups.flatMap(([, newSide]) => newSide)).toEqual(newLines);
  });

  it('pairs the most similar lines in one group', () => {
    const matcher = newMatcherFn(newDistanceFn<string>(value => value));

    const groups = matcher(['const value = 1;', 'other();'], ['const value = 2;', 'other();']);

    expect(groups).toContainEqual([['const value = 1;'], ['const value = 2;']]);
  });

  it('keeps short inputs in a single group', () => {
    const matcher = newMatcherFn(newDistanceFn<string>(value => value));

    expect(matcher(['a'], ['b'])).toEqual([[['a'], ['b']]]);
  });
});
