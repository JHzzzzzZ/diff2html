import { computeExpandRange, unchangedLineDelta } from '../context-expand';

describe('context-expand', () => {
  describe('up direction', () => {
    it('expands up by chunk size, stopping just above the hunk boundary', () => {
      // File has 100 lines. Hunk starts at line 30. Chunk = 20.
      const range = computeExpandRange({ direction: 'up', boundary: 30, fileStart: 1, fileEnd: 100, chunkSize: 20 });
      expect(range).toEqual({ from: 10, to: 29 });
    });

    it('reaches file start when fewer lines remain above than chunk size', () => {
      // Hunk starts at line 5; only 4 lines above.
      const range = computeExpandRange({ direction: 'up', boundary: 5, fileStart: 1, fileEnd: 100, chunkSize: 20 });
      expect(range).toEqual({ from: 1, to: 4 });
    });

    it('returns null when there are no lines above the hunk', () => {
      const range = computeExpandRange({ direction: 'up', boundary: 1, fileStart: 1, fileEnd: 100, chunkSize: 20 });
      expect(range).toBeNull();
    });
  });

  describe('down direction', () => {
    it('expands down by chunk size, stopping just below the hunk boundary', () => {
      // Hunk ends at line 50.
      const range = computeExpandRange({ direction: 'down', boundary: 50, fileStart: 1, fileEnd: 100, chunkSize: 20 });
      expect(range).toEqual({ from: 51, to: 70 });
    });

    it('reaches file end when fewer lines remain below than chunk size', () => {
      // Hunk ends at line 90; only 10 lines below.
      const range = computeExpandRange({ direction: 'down', boundary: 90, fileStart: 1, fileEnd: 100, chunkSize: 20 });
      expect(range).toEqual({ from: 91, to: 100 });
    });

    it('returns null when there are no lines below the hunk', () => {
      const range = computeExpandRange({ direction: 'down', boundary: 100, fileStart: 1, fileEnd: 100, chunkSize: 20 });
      expect(range).toBeNull();
    });
  });
});

describe('unchangedLineDelta (side-by-side)', () => {
  it('delta before a block = newStart - oldStart', () => {
    const blocks = [{ newStartLine: 30, oldStartLine: 28, lines: [] }];
    expect(unchangedLineDelta(blocks, 0)).toBe(2);
  });

  it('delta after the last block = last new number - last old number', () => {
    const blocks = [
      {
        newStartLine: 10,
        oldStartLine: 10,
        lines: [
          { oldNumber: 10, newNumber: undefined, type: 0, content: '' },
          { oldNumber: undefined, newNumber: 15, type: 1 },
        ],
      },
    ];
    // last new number = 15, last old number = 10 → delta 5
    expect(unchangedLineDelta(blocks, 1)).toBe(5);
  });

  it('is zero when the block adds as many lines as it removes', () => {
    const blocks = [
      {
        newStartLine: 5,
        oldStartLine: 5,
        lines: [
          { oldNumber: 5, newNumber: undefined, type: 0 },
          { oldNumber: undefined, newNumber: 5, type: 1 },
        ],
      },
    ];
    expect(unchangedLineDelta(blocks, 1)).toBe(0);
  });
});
