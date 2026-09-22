# Context

## Glossary

### Review

A set of user comments attached to a rendered diff. A Review contains line-level comments (anchored to a file and line
number) and file-level comments (attached to a whole file). Reviews can be exported to and imported from JSON.

### Line comment

A comment anchored to one line of one file. The anchor is `(filePath, lineNumber)`, where `lineNumber` is the new-file
line number for added/context lines and the old-file line number for deleted lines. Expansion of surrounding context
does not move or invalidate anchors.

### File comment

A comment attached to a whole file, identified by its file path. Has no line anchor.

### Context expansion

Revealing real file content that surrounds a diff hunk, without changing the diff itself. Expansion is directional (`up`
reveals lines above the hunk, `down` reveals lines below), reveals a bounded number of lines per click
(`expandChunkSize`), and shows a placeholder with the count of still-hidden lines when the file has more content beyond
the revealed range.

### Context provider

The caller-supplied source of real file content. Either a callback `(path, from, to) => Promise<string[]>` returning the
requested line range, an in-memory full-content map (`fileContents`), or both; the callback wins when both are present.

### Path resolver

A caller-supplied mapping from a diff path (as it appears in the diff text, e.g. `a/src/app.ts`) to a real file path
used for content lookup and review anchors.
