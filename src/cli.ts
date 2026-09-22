#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { html } from './diff2html';

export const USAGE = `Usage: diff2html [options] [diff-file]

Convert a git/unified diff into a standalone interactive HTML page.
Reads stdin when no diff file is given (or '-' is passed).

Options:
  -o, --output <file>        Output HTML file; defaults to <diff-file>.html,
                             or stdout when reading from stdin
  -f, --format <format>      line-by-line | side-by-side (default: line-by-line)
      --matching <mode>      none | lines | words (default: lines)
      --file-contents <map>  JSON object mapping file path to full file text;
                             enables dynamic context expansion around hunks
  -t, --title <title>        Page title (default: diff2html)
  -h, --help                 Show this help

Example:
  git diff | diff2html -o review.html --file-contents contents.json
`;

export type OutputFormat = 'line-by-line' | 'side-by-side';
export type MatchingMode = 'none' | 'lines' | 'words';

export interface CliOptions {
  input?: string;
  output?: string;
  format: OutputFormat;
  matching: MatchingMode;
  fileContents?: string;
  title: string;
  help: boolean;
}

export class CliError extends Error {}

const FORMATS: readonly string[] = ['line-by-line', 'side-by-side'];
const MATCHINGS: readonly string[] = ['none', 'lines', 'words'];

/** Pure command line parser: the last positional argument wins. */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { format: 'line-by-line', matching: 'lines', title: 'diff2html', help: false };
  const takeValue = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('-')) throw new CliError(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-o':
      case '--output':
        opts.output = takeValue(arg, i);
        i += 1;
        break;
      case '-f':
      case '--format':
        opts.format = takeValue(arg, i) as OutputFormat;
        i += 1;
        if (!FORMATS.includes(opts.format)) throw new CliError(`--format must be one of: ${FORMATS.join(', ')}`);
        break;
      case '--matching':
        opts.matching = takeValue(arg, i) as MatchingMode;
        i += 1;
        if (!MATCHINGS.includes(opts.matching))
          throw new CliError(`--matching must be one of: ${MATCHINGS.join(', ')}`);
        break;
      case '--file-contents':
        opts.fileContents = takeValue(arg, i);
        i += 1;
        break;
      case '-t':
      case '--title':
        opts.title = takeValue(arg, i);
        i += 1;
        break;
      default:
        if (arg.startsWith('-') && arg !== '-') throw new CliError(`Unknown option: ${arg}`);
        opts.input = arg;
    }
  }
  return opts;
}

/** Escapes `<` so embedded JSON cannot break out of a script element. */
export const embed = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

export interface RenderInput {
  diffText: string;
  format: OutputFormat;
  matching: MatchingMode;
  fileContents: Record<string, string> | undefined;
  title: string;
  /** Absolute paths to the browser bundles; overridable for tests. */
  bundlesDir?: string;
}

/**
 * Renders the diff server-side and wraps it in a standalone page with the
 * CSS and browser bundles inlined, wired for context expansion and review.
 */
export function renderPage(input: RenderInput): string {
  const { diffText, format, matching, fileContents, title } = input;
  const bundlesDir = input.bundlesDir ?? path.join(__dirname, '..', 'bundles');

  const renderConfig = { drawFileList: true, matching, outputFormat: format };
  const diffHtml = html(diffText, renderConfig);

  const css = fs.readFileSync(path.join(bundlesDir, 'css', 'diff2html.min.css'), 'utf8');
  const coreJs = fs.readFileSync(path.join(bundlesDir, 'js', 'diff2html.min.js'), 'utf8');
  const uiJs = fs.readFileSync(path.join(bundlesDir, 'js', 'diff2html-ui.min.js'), 'utf8');

  const safeTitle = title.replace(/[<>&]/g, '');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>${css}</style>
</head>
<body style="margin:0">
<div id="diff">${diffHtml}</div>
<script>${coreJs}</script>
<script>${uiJs}</script>
<script>
const DIFF_TEXT = ${embed(diffText)};
const FILE_CONTENTS_JSON = ${embed(fileContents ?? {})};
const fileContents = new Map(
  Object.entries(FILE_CONTENTS_JSON).map(([filePath, text]) => [filePath, String(text).split('\\n')]),
);
const ui = new Diff2HtmlUI(document.getElementById('diff'), DIFF_TEXT, {
  ...${embed(renderConfig)},
  fileCopyButton: true,
  contextExpansion: true,
  expandChunkSize: 20,
  review: true,
  fileContents,
});
ui.draw();
</script>
</body>
</html>
`;
}

function readFileContents(mapPath: string): Record<string, string> {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.resolve(mapPath), 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('--file-contents must be a JSON object mapping path to file text');
  }
  return parsed as Record<string, string>;
}

export function main(argv: string[]): number {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    const diffText =
      opts.input === undefined || opts.input === '-'
        ? fs.readFileSync(0, 'utf8')
        : fs.readFileSync(path.resolve(opts.input), 'utf8');
    const fileContents = opts.fileContents === undefined ? undefined : readFileContents(opts.fileContents);
    const page = renderPage({
      diffText,
      format: opts.format,
      matching: opts.matching,
      fileContents,
      title: opts.title,
    });

    if (opts.output !== undefined) {
      fs.writeFileSync(path.resolve(opts.output), page);
    } else if (opts.input !== undefined && opts.input !== '-') {
      fs.writeFileSync(path.resolve(`${opts.input}.html`), page);
    } else {
      process.stdout.write(page);
      return 0;
    }
    process.stderr.write(
      `wrote ${path.resolve(opts.output ?? `${opts.input}.html`)} (${(page.length / 1024).toFixed(0)} KB)\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`diff2html: ${(error as Error).message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
