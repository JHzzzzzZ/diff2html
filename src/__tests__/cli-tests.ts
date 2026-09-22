import { CliError, embed, parseArgs, renderPage } from '../cli';

describe('cli parseArgs', () => {
  it('returns defaults when given no arguments', () => {
    expect(parseArgs([])).toEqual({ format: 'line-by-line', matching: 'lines', title: 'diff2html', help: false });
  });

  it('parses an input file and the output flag', () => {
    const opts = parseArgs(['changes.diff', '-o', 'out.html']);
    expect(opts.input).toBe('changes.diff');
    expect(opts.output).toBe('out.html');
  });

  it('treats a lone dash as stdin input', () => {
    expect(parseArgs(['-']).input).toBe('-');
  });

  it('parses format, matching, file contents and title', () => {
    const opts = parseArgs([
      '--format',
      'side-by-side',
      '--matching',
      'none',
      '--file-contents',
      'map.json',
      '--title',
      'Review',
    ]);
    expect(opts.format).toBe('side-by-side');
    expect(opts.matching).toBe('none');
    expect(opts.fileContents).toBe('map.json');
    expect(opts.title).toBe('Review');
  });

  it('rejects an unknown option', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(CliError);
  });

  it('rejects an invalid format value', () => {
    expect(() => parseArgs(['--format', 'diagonal'])).toThrow(CliError);
  });

  it('rejects a missing flag value', () => {
    expect(() => parseArgs(['-o'])).toThrow(CliError);
    expect(() => parseArgs(['--format', '--matching'])).toThrow(CliError);
  });
});

describe('cli embed', () => {
  it('escapes < so json cannot break out of a script element', () => {
    expect(embed('</script>')).toBe('"\\u003c/script>"');
  });
});

describe('cli renderPage', () => {
  const bundlesDir = './bundles';

  it('renders a standalone page with inlined bundles and the diff html', () => {
    const page = renderPage({
      diffText: 'diff --git a/x.txt b/x.txt\nindex 1..2 100644\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n',
      format: 'line-by-line',
      matching: 'none',
      fileContents: undefined,
      title: 'My Review',
      bundlesDir,
    });
    expect(page).toContain('<title>My Review</title>');
    expect(page).toContain('d2h-file-wrapper');
    expect(page).toContain('Diff2HtmlUI');
    expect(page).toContain('ui.draw()');
  });

  it('embeds file contents for context expansion', () => {
    const page = renderPage({
      diffText: 'diff --git a/x.txt b/x.txt\nindex 1..2 100644\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n',
      format: 'side-by-side',
      matching: 'lines',
      fileContents: { 'x.txt': 'a\nb\nc' },
      title: 't',
      bundlesDir,
    });
    expect(page).toContain('"x.txt"');
    expect(page).toContain('contextExpansion: true');
    expect(page).toContain('side-by-side');
  });

  it('strips html from the page title', () => {
    const page = renderPage({
      diffText: 'diff --git a/x.txt b/x.txt\nindex 1..2 100644\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n',
      format: 'line-by-line',
      matching: 'none',
      fileContents: undefined,
      title: '<script>x</script>',
      bundlesDir,
    });
    expect(page).not.toContain('<title><script>');
    expect(page).toContain('<title>scriptx/script</title>');
  });
});
