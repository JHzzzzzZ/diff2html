import { commitReveal, GapState, nextRevealRange, unchangedLineDelta } from '../context-expand';

describe('nextRevealRange', () => {
  describe('down direction', () => {
    it('reveals one chunk just below the upper edge', () => {
      const range = nextRevealRange({ hiddenTop: 10, hiddenBottom: 50 }, 'down', 20);
      expect(range).toEqual({ from: 11, to: 30 });
    });

    it('clamps at hiddenBottom when fewer lines remain than the chunk size', () => {
      const range = nextRevealRange({ hiddenTop: 10, hiddenBottom: 25 }, 'down', 20);
      expect(range).toEqual({ from: 11, to: 25 });
    });

    it('returns null when the gap is exhausted', () => {
      expect(nextRevealRange({ hiddenTop: 50, hiddenBottom: 50 }, 'down', 20)).toBeNull();
    });

    it('reveals a full open-ended chunk on an open-bottom gap', () => {
      const range = nextRevealRange({ hiddenTop: 90, hiddenBottom: null }, 'down', 20);
      expect(range).toEqual({ from: 91, to: 110 });
    });
  });

  describe('up direction', () => {
    it('reveals one chunk just above the lower edge', () => {
      const range = nextRevealRange({ hiddenTop: 10, hiddenBottom: 50 }, 'up', 20);
      expect(range).toEqual({ from: 31, to: 50 });
    });

    it('clamps at hiddenTop when fewer lines remain than the chunk size', () => {
      // 15 lines hidden (11..25); one up reveal takes them all.
      const range = nextRevealRange({ hiddenTop: 10, hiddenBottom: 25 }, 'up', 20);
      expect(range).toEqual({ from: 11, to: 25 });
    });

    it('returns null when the gap is exhausted', () => {
      expect(nextRevealRange({ hiddenTop: 10, hiddenBottom: 10 }, 'up', 20)).toBeNull();
    });

    it('returns null on an open-bottom gap (nothing above to expand into)', () => {
      expect(nextRevealRange({ hiddenTop: 90, hiddenBottom: null }, 'up', 20)).toBeNull();
    });
  });

  describe('alternating up/down on a shared state', () => {
    it('meets exactly in the middle without overlapping', () => {
      // 40 hidden lines (11..50).
      let state: GapState = { hiddenTop: 10, hiddenBottom: 50 };

      const down = nextRevealRange(state, 'down', 20)!;
      expect(down).toEqual({ from: 11, to: 30 });
      state = commitReveal(state, 'down', down).state;

      const up = nextRevealRange(state, 'up', 20)!;
      expect(up).toEqual({ from: 31, to: 50 });
      const outcome = commitReveal(state, 'up', up);
      expect(outcome.remaining).toBe(0);
      expect(outcome.exhausted).toBe(true);

      expect(nextRevealRange(outcome.state, 'down', 20)).toBeNull();
      expect(nextRevealRange(outcome.state, 'up', 20)).toBeNull();
    });

    it('tracks the shared remaining count across both sides', () => {
      // 36 hidden lines (1..36): gap above the first hunk.
      const state: GapState = { hiddenTop: 0, hiddenBottom: 36 };

      const up = nextRevealRange(state, 'up', 20)!;
      expect(up).toEqual({ from: 17, to: 36 });
      let outcome = commitReveal(state, 'up', up);
      expect(outcome.remaining).toBe(16);

      // Second up reveal clamps at file start and finishes the gap.
      const up2 = nextRevealRange(outcome.state, 'up', 20)!;
      expect(up2).toEqual({ from: 1, to: 16 });
      outcome = commitReveal(outcome.state, 'up', up2);
      expect(outcome.state).toEqual({ hiddenTop: 0, hiddenBottom: 0 });
      expect(outcome.exhausted).toBe(true);
    });
  });
});

describe('commitReveal', () => {
  it('advances hiddenTop on down, keeping hiddenBottom', () => {
    const outcome = commitReveal({ hiddenTop: 10, hiddenBottom: 50 }, 'down', { from: 11, to: 30 });
    expect(outcome.state).toEqual({ hiddenTop: 30, hiddenBottom: 50 });
    expect(outcome.remaining).toBe(20);
    expect(outcome.exhausted).toBe(false);
  });

  it('advances hiddenBottom on up, keeping hiddenTop', () => {
    const outcome = commitReveal({ hiddenTop: 10, hiddenBottom: 50 }, 'up', { from: 31, to: 50 });
    expect(outcome.state).toEqual({ hiddenTop: 10, hiddenBottom: 30 });
    expect(outcome.remaining).toBe(20);
    expect(outcome.exhausted).toBe(false);
  });

  it('never exhausts an open-bottom gap (remaining stays null)', () => {
    const outcome = commitReveal({ hiddenTop: 90, hiddenBottom: null }, 'down', { from: 91, to: 110 });
    expect(outcome.state).toEqual({ hiddenTop: 110, hiddenBottom: null });
    expect(outcome.remaining).toBeNull();
    expect(outcome.exhausted).toBe(false);
  });

  it('advances by the clamped range when the source ran dry', () => {
    // Asked for 11..30 but only 11..20 arrived.
    const outcome = commitReveal({ hiddenTop: 10, hiddenBottom: 50 }, 'down', { from: 11, to: 20 });
    expect(outcome.state).toEqual({ hiddenTop: 20, hiddenBottom: 50 });
    expect(outcome.remaining).toBe(30);
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
