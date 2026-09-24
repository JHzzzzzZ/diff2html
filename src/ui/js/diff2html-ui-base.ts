import { closeTags, nodeStream, mergeStreams, getLanguage } from './highlight.js-helpers';

import { html, parse, Diff2HtmlConfig, defaultDiff2HtmlConfig } from '../../diff2html';
import { DiffFile } from '../../types';
import { getHtmlId } from '../../render-utils';
import { HighlightResult, HLJSApi } from 'highlight.js';
import { ContextExpansionConfig, ContextExpansionUI } from './diff2html-ui-context';
import { ReviewImportReport, ReviewUI, ReviewUIConfig } from './diff2html-ui-review';
import { CommentSide } from '../../review';

export interface Diff2HtmlUIConfig extends Diff2HtmlConfig, ContextExpansionConfig, ReviewUIConfig {
  synchronisedScroll?: boolean;
  highlight?: boolean;
  fileListToggle?: boolean;
  fileListStartVisible?: boolean;
  highlightLanguages?: Map<string, string>;
  /**
   * @deprecated since version 3.1.0
   * Smart selection is now enabled by default with vanilla CSS
   */
  smartSelection?: boolean;
  fileContentToggle?: boolean;
  stickyFileHeaders?: boolean;
  /** Enables dynamic context expansion; requires `contextProvider` or `fileContents`. */
  contextExpansion?: boolean;
  /** Enables review comments, the comment navigation panel and `exportReview` / `importReview`. */
  review?: boolean;
  /** Adds a copy-to-clipboard button next to each file name; default is `true`. */
  fileCopyButton?: boolean;
}

export const defaultDiff2HtmlUIConfig = {
  ...defaultDiff2HtmlConfig,
  synchronisedScroll: true,
  highlight: true,
  fileListToggle: true,
  fileListStartVisible: false,
  highlightLanguages: new Map<string, string>(),
  /**
   * @deprecated since version 3.1.0
   * Smart selection is now enabled by default with vanilla CSS
   */
  smartSelection: true,
  fileContentToggle: true,
  stickyFileHeaders: true,
  contextExpansion: true,
  review: false,
  fileCopyButton: true,
};

export class Diff2HtmlUI {
  readonly config: typeof defaultDiff2HtmlUIConfig;
  readonly diffHtml: string;
  readonly targetElement: HTMLElement;
  readonly hljs: HLJSApi | null = null;
  readonly review?: ReviewUI;

  private readonly diffFiles: DiffFile[];
  private readonly contextExpansion?: ContextExpansionUI;

  currentSelectionColumnId = -1;

  constructor(target: HTMLElement, diffInput?: string | DiffFile[], config: Diff2HtmlUIConfig = {}, hljs?: HLJSApi) {
    this.config = { ...defaultDiff2HtmlUIConfig, ...config };
    this.diffFiles =
      diffInput === undefined ? [] : typeof diffInput === 'string' ? parse(diffInput, this.config) : diffInput;
    this.diffHtml = diffInput !== undefined ? html(diffInput, this.config) : target.innerHTML;
    this.targetElement = target;
    if (hljs !== undefined) this.hljs = hljs;
    if (this.config.review) {
      this.review = new ReviewUI({
        author: config.author,
        onReviewChange: config.onReviewChange,
        revealLine: (file, side, lineNumber) => this.revealLine(file, side, lineNumber),
      });
    }
    if (this.config.contextExpansion && (config.contextProvider !== undefined || config.fileContents !== undefined)) {
      this.contextExpansion = new ContextExpansionUI({
        contextProvider: config.contextProvider,
        fileContents: config.fileContents,
        pathResolver: config.pathResolver,
        expandChunkSize: config.expandChunkSize,
      });
    }
  }

  draw(): void {
    this.targetElement.innerHTML = this.diffHtml;
    if (this.config.synchronisedScroll) this.synchronisedScroll();
    if (this.config.highlight) this.highlightCode();
    if (this.config.fileListToggle) this.fileListToggle(this.config.fileListStartVisible);
    if (this.config.fileContentToggle) this.fileContentToggle();
    if (this.config.stickyFileHeaders) this.stickyFileHeaders();
    if (this.config.fileCopyButton) this.fileCopyButtons();
    if (this.contextExpansion !== undefined) this.wireContextExpansion();
    if (this.review !== undefined) {
      this.review.wireToolbar(this.targetElement);
      this.review.wire(this.targetElement, this.diffFiles);
    }
  }

  /** Returns the current review as JSON (requires `review: true`). */
  exportReview(): string {
    if (this.review === undefined) throw new Error('Review is not enabled. Pass `review: true` in the config.');
    return this.review.exportReview();
  }

  /**
   * Loads a review previously produced by `exportReview` (requires
   * `review: true`). Resolves with what was imported, skipped and placed;
   * comments on collapsed lines are revealed first.
   */
  importReview(json: string): Promise<ReviewImportReport> {
    if (this.review === undefined) throw new Error('Review is not enabled. Pass `review: true` in the config.');
    return this.review.importReview(json);
  }

  /** Bridge to the context expansion UI; without it no line can be revealed. */
  private revealLine(file: DiffFile, side: CommentSide, lineNumber: number): Promise<boolean> {
    if (this.contextExpansion === undefined) return Promise.resolve(false);
    return this.contextExpansion.revealLine(file, side, lineNumber);
  }

  private fileCopyButtons(): void {
    this.targetElement.querySelectorAll<HTMLElement>('.d2h-file-header').forEach(header => {
      const wrapper = header.querySelector('.d2h-file-name-wrapper');
      const fileName = header.querySelector<HTMLElement>('.d2h-file-name');
      if (wrapper === null || fileName === null) return;

      const file = this.diffFiles.find(f => getHtmlId(f) === header.closest('.d2h-file-wrapper')?.id);
      const copyText = file === undefined ? (fileName.textContent ?? '') : anchorCopyPath(file);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'd2h-file-copy-btn';
      button.title = '复制文件路径';
      button.textContent = '复制';
      button.addEventListener('click', () => {
        void copyToClipboard(copyText).then(() => {
          button.textContent = '已复制';
          window.setTimeout(() => (button.textContent = '复制'), 1200);
          return null;
        });
      });

      fileName.parentNode!.insertBefore(button, fileName.nextSibling);
    });
  }

  private wireContextExpansion(): void {
    this.diffFiles.forEach(file => {
      if (!this.contextExpansion!.canExpand(file)) return;
      const wrapper = this.targetElement.querySelector(`#${getHtmlId(file)}`);
      if (wrapper !== null) this.contextExpansion!.wireFile(file, wrapper);
    });
  }

  synchronisedScroll(): void {
    this.targetElement.querySelectorAll('.d2h-file-wrapper').forEach(wrapper => {
      const [left, right] = Array<Element>().slice.call(wrapper.querySelectorAll('.d2h-file-side-diff'));

      if (left === undefined || right === undefined) return;

      const onScroll = (event: Event): void => {
        if (event === null || event.target === null) return;

        if (event.target === left) {
          right.scrollTop = left.scrollTop;
          right.scrollLeft = left.scrollLeft;
        } else {
          left.scrollTop = right.scrollTop;
          left.scrollLeft = right.scrollLeft;
        }
      };
      left.addEventListener('scroll', onScroll);
      right.addEventListener('scroll', onScroll);
    });
  }

  fileListToggle(startVisible: boolean): void {
    const showBtn: HTMLElement | null = this.targetElement.querySelector('.d2h-show');
    const hideBtn: HTMLElement | null = this.targetElement.querySelector('.d2h-hide');
    const fileList: HTMLElement | null = this.targetElement.querySelector('.d2h-file-list');

    if (showBtn === null || hideBtn === null || fileList === null) return;

    const show: () => void = () => {
      showBtn.style.display = 'none';
      hideBtn.style.display = 'inline';
      fileList.style.display = 'block';
    };

    const hide: () => void = () => {
      showBtn.style.display = 'inline';
      hideBtn.style.display = 'none';
      fileList.style.display = 'none';
    };

    showBtn.addEventListener('click', () => show());
    hideBtn.addEventListener('click', () => hide());

    const hashTag = this.getHashTag();
    if (hashTag === 'files-summary-show') show();
    else if (hashTag === 'files-summary-hide') hide();
    else if (startVisible) show();
    else hide();
  }

  fileContentToggle(): void {
    this.targetElement.querySelectorAll<HTMLElement>('.d2h-file-collapse').forEach(fileContentToggleBtn => {
      fileContentToggleBtn.style.display = 'flex';

      const toggleFileContents: (selector: string) => void = selector => {
        const fileContents: HTMLElement | null | undefined = fileContentToggleBtn
          .closest('.d2h-file-wrapper')
          ?.querySelector(selector);

        if (fileContents !== null && fileContents !== undefined) {
          fileContentToggleBtn.classList.toggle('d2h-selected');
          fileContents.classList.toggle('d2h-d-none');
        }
      };

      const toggleHandler: (e: Event) => void = e => {
        if (fileContentToggleBtn === e.target) return;

        toggleFileContents('.d2h-file-diff');
        toggleFileContents('.d2h-files-diff');
      };

      fileContentToggleBtn.addEventListener('click', e => toggleHandler(e));
    });
  }

  highlightCode(): void {
    const hljs = this.hljs;
    if (hljs === null) {
      throw new Error('Missing a `highlight.js` implementation. Please provide one when instantiating Diff2HtmlUI.');
    }

    // Collect all the diff files and execute the highlight on their lines
    const files = this.targetElement.querySelectorAll('.d2h-file-wrapper');
    files.forEach(file => {
      const language = file.getAttribute('data-lang');

      if (!(this.config.highlightLanguages instanceof Map)) {
        this.config.highlightLanguages = new Map(Object.entries(this.config.highlightLanguages));
      }

      let hljsLanguage =
        language && this.config.highlightLanguages.has(language)
          ? this.config.highlightLanguages.get(language)!
          : language
            ? getLanguage(language)
            : 'plaintext';

      // Fallback to plaintext in case language is not loaded
      if (hljs.getLanguage(hljsLanguage) === undefined) {
        hljsLanguage = 'plaintext';
      }

      // Collect all the code lines and execute the highlight on them
      const codeLines = file.querySelectorAll('.d2h-code-line-ctn');
      codeLines.forEach(line => {
        const text = line.textContent;
        const lineParent = line.parentNode;

        if (text === null || lineParent === null || !this.isElement(lineParent)) return;

        const result: HighlightResult = closeTags(
          hljs.highlight(text, {
            language: hljsLanguage,
            ignoreIllegals: true,
          }),
        );

        const originalStream = nodeStream(line);
        if (originalStream.length) {
          const resultNode = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
          resultNode.innerHTML = result.value;
          result.value = mergeStreams(originalStream, nodeStream(resultNode), text);
        }

        line.classList.add('hljs');
        if (result.language) {
          line.classList.add(result.language);
        }
        line.innerHTML = result.value;
      });
    });
  }

  stickyFileHeaders(): void {
    this.targetElement.querySelectorAll('.d2h-file-header').forEach(header => {
      header.classList.add('d2h-sticky-header');
    });
  }

  /**
   * @deprecated since version 3.1.0
   */
  smartSelection(): void {
    console.warn('Smart selection is now enabled by default with CSS. No need to call this method anymore.');
  }

  private getHashTag(): string | null {
    const docUrl = document.URL;
    const hashTagIndex = docUrl.indexOf('#');

    let hashTag = null;
    if (hashTagIndex !== -1) {
      hashTag = docUrl.substr(hashTagIndex + 1);
    }

    return hashTag;
  }

  private isElement(arg?: unknown): arg is Element {
    return arg !== null && (arg as Element)?.classList !== undefined;
  }
}

function anchorCopyPath(file: DiffFile): string {
  return file.newName === '/dev/null' ? file.oldName : file.newName;
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard !== undefined) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // Fallback for non-secure contexts (plain http pages).
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}
