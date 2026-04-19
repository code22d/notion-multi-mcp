// -----------------------------------------------------------------------------
// Inline Markdown → Notion RichTextItemRequest[]
//
// Walks `marked`'s inline token tree and emits Notion rich-text runs. Handles:
//   - bold (**/_), italic (*/_), strikethrough (~~), inline code (`)
//   - links [text](url)
//   - underline via <u>...</u>
//   - inline equations via $...$
//   - mentions via <page id="…">, <database id="…">, <user id="…">, <date>…</date>
//
// Rich text runs in Notion are flat (no nesting). Nested annotations in the
// Markdown token tree are flattened by merging the annotations of each ancestor
// into the leaf text run.
// -----------------------------------------------------------------------------

import type { Token, Tokens } from "marked";

type Annotations = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: string;
};

export type RichTextRun =
  | {
      type: "text";
      text: { content: string; link?: { url: string } | null };
      annotations?: Annotations;
    }
  | {
      type: "equation";
      equation: { expression: string };
      annotations?: Annotations;
    }
  | {
      type: "mention";
      mention:
        | { type: "page"; page: { id: string } }
        | { type: "database"; database: { id: string } }
        | { type: "user"; user: { id: string } }
        | { type: "date"; date: { start: string; end?: string | null } };
      annotations?: Annotations;
    };

/** Notion caps each rich_text content run at 2000 characters. */
const MAX_RUN_LENGTH = 2000;

/** Parses inline Markdown tokens (from marked) into Notion rich-text runs. */
export function tokensToRichText(tokens: Token[] | undefined, parentAnn: Annotations = {}): RichTextRun[] {
  if (!tokens || tokens.length === 0) return [];
  const runs: RichTextRun[] = [];
  // Marked splits HTML inline tags into separate open/close `html` tokens. We
  // fold `<u>…</u>`, mention tags and `<date>…</date>` across that boundary so
  // the underline annotation / mention payload sticks.
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const folded = tryFoldHtmlSpan(tokens, i, parentAnn);
    if (folded) {
      runs.push(...folded.runs);
      i = folded.nextIndex;
      continue;
    }
    runs.push(...tokenToRichText(tok, parentAnn));
  }
  return mergeAdjacent(runs).flatMap(splitLongRuns);
}

type FoldResult = { runs: RichTextRun[]; nextIndex: number };

function htmlText(tok: Token): string {
  return ((tok as { text?: string; raw?: string }).text ?? (tok as { raw?: string }).raw ?? "").trim();
}

/**
 * Detect an opening HTML tag we recognise as a span (underline or mention) and
 * consume tokens up to the matching close tag. Returns null if `tokens[i]` is
 * not a recognised opener.
 */
function tryFoldHtmlSpan(tokens: Token[], i: number, parentAnn: Annotations): FoldResult | null {
  const open = tokens[i]!;
  if (open.type !== "html") return null;
  const raw = htmlText(open);

  const matchers: Array<{
    re: RegExp;
    close: RegExp;
    build: (inner: Token[], m: RegExpMatchArray) => RichTextRun[];
  }> = [
    {
      re: /^<u>$/i,
      close: /^<\/u>$/i,
      build: (inner) => tokensToRichText(inner, { ...parentAnn, underline: true }),
    },
    {
      re: /^<page\s+id="([^"]+)"\s*>$/i,
      close: /^<\/page>$/i,
      build: (_inner, m) => [
        {
          type: "mention",
          mention: { type: "page", page: { id: m[1]! } },
          annotations: emptyIfUseless(parentAnn),
        },
      ],
    },
    {
      re: /^<database\s+id="([^"]+)"\s*>$/i,
      close: /^<\/database>$/i,
      build: (_inner, m) => [
        {
          type: "mention",
          mention: { type: "database", database: { id: m[1]! } },
          annotations: emptyIfUseless(parentAnn),
        },
      ],
    },
    {
      re: /^<user\s+id="([^"]+)"\s*>$/i,
      close: /^<\/user>$/i,
      build: (_inner, m) => [
        {
          type: "mention",
          mention: { type: "user", user: { id: m[1]! } },
          annotations: emptyIfUseless(parentAnn),
        },
      ],
    },
    {
      re: /^<date>$/i,
      close: /^<\/date>$/i,
      build: (inner) => {
        const dateStr = inner
          .map((t) => (t as { text?: string; raw?: string }).text ?? (t as { raw?: string }).raw ?? "")
          .join("")
          .trim();
        const [start, end] = dateStr.split(/\s*(?:→|->)\s*/);
        return [
          {
            type: "mention",
            mention: { type: "date", date: { start: start ?? "", end: end ?? null } },
            annotations: emptyIfUseless(parentAnn),
          },
        ];
      },
    },
  ];

  for (const matcher of matchers) {
    const m = raw.match(matcher.re);
    if (!m) continue;
    // Scan forward to the matching close tag.
    const inner: Token[] = [];
    let j = i + 1;
    for (; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.type === "html" && matcher.close.test(htmlText(t))) break;
      inner.push(t);
    }
    return { runs: matcher.build(inner, m), nextIndex: j };
  }
  return null;
}

/** Parse a raw string of inline Markdown into rich-text runs. */
export function inlineMarkdownToRichText(
  source: string,
  lexer: { inlineTokens: (src: string) => Token[] }
): RichTextRun[] {
  const toks = lexer.inlineTokens(source);
  return tokensToRichText(toks);
}

function tokenToRichText(tok: Token, ann: Annotations): RichTextRun[] {
  switch (tok.type) {
    case "text": {
      const t = tok as Tokens.Text;
      // Text tokens may have inner tokens (e.g. when they include emphasis children).
      if (t.tokens && t.tokens.length > 0) {
        return tokensToRichText(t.tokens, ann);
      }
      return scanExtensions(unescapeEntities(t.text), ann);
    }
    case "escape": {
      const t = tok as Tokens.Escape;
      return [textRun(t.text, ann)];
    }
    case "strong": {
      const t = tok as Tokens.Strong;
      return tokensToRichText(t.tokens, { ...ann, bold: true });
    }
    case "em": {
      const t = tok as Tokens.Em;
      return tokensToRichText(t.tokens, { ...ann, italic: true });
    }
    case "del": {
      const t = tok as Tokens.Del;
      return tokensToRichText(t.tokens, { ...ann, strikethrough: true });
    }
    case "codespan": {
      const t = tok as Tokens.Codespan;
      return [textRun(unescapeEntities(t.text), { ...ann, code: true })];
    }
    case "link": {
      const t = tok as Tokens.Link;
      // Child tokens keep their own styling; propagate link url onto each leaf.
      const inner = tokensToRichText(t.tokens, ann);
      return inner.map((run) => attachLink(run, t.href));
    }
    case "image": {
      const t = tok as Tokens.Image;
      // Inline images aren't a thing in Notion rich text; emit a fallback text run.
      return [textRun(`[${t.text}](${t.href})`, ann)];
    }
    case "br":
      return [textRun("\n", ann)];
    case "html": {
      const t = tok as Tokens.Tag | Tokens.HTML;
      return parseInlineHtml(t.text ?? t.raw, ann);
    }
    default: {
      // Unknown inline token — fall back to raw text if available.
      const raw = (tok as { raw?: string }).raw ?? "";
      return raw ? scanExtensions(raw, ann) : [];
    }
  }
}

// -----------------------------------------------------------------------------
// Notion extensions inside raw text: $...$ equations + <page|database|user|date> mentions
// -----------------------------------------------------------------------------

const EXTENSION_RE =
  /(<u>([\s\S]*?)<\/u>)|(<page\s+id="([^"]+)"\s*>([\s\S]*?)<\/page>)|(<database\s+id="([^"]+)"\s*>([\s\S]*?)<\/database>)|(<user\s+id="([^"]+)"\s*>([\s\S]*?)<\/user>)|(<date>([\s\S]*?)<\/date>)|(\$([^$\n][\s\S]*?[^$\n])\$)|(\$([^$\s]+?)\$)/;

function scanExtensions(text: string, ann: Annotations): RichTextRun[] {
  const runs: RichTextRun[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const m = remaining.match(EXTENSION_RE);
    if (!m || m.index === undefined) {
      runs.push(textRun(remaining, ann));
      break;
    }
    if (m.index > 0) runs.push(textRun(remaining.slice(0, m.index), ann));
    // Which group matched?
    if (m[1]) {
      // <u>..</u>
      runs.push(...scanExtensions(m[2] ?? "", { ...ann, underline: true }));
    } else if (m[3]) {
      // <page id="..">..</page>
      runs.push({
        type: "mention",
        mention: { type: "page", page: { id: m[4]! } },
        annotations: emptyIfUseless(ann),
      });
    } else if (m[6]) {
      // <database id="..">..</database>
      runs.push({
        type: "mention",
        mention: { type: "database", database: { id: m[7]! } },
        annotations: emptyIfUseless(ann),
      });
    } else if (m[9]) {
      // <user id="..">..</user>
      runs.push({
        type: "mention",
        mention: { type: "user", user: { id: m[10]! } },
        annotations: emptyIfUseless(ann),
      });
    } else if (m[12]) {
      // <date>..</date>
      const raw = (m[13] ?? "").trim();
      const [start, end] = raw.split(/\s*→\s*|\s*->\s*/);
      runs.push({
        type: "mention",
        mention: {
          type: "date",
          date: { start: start ?? "", end: end ?? null },
        },
        annotations: emptyIfUseless(ann),
      });
    } else if (m[14]) {
      // $ … $ with content (non-whitespace at both ends)
      runs.push({
        type: "equation",
        equation: { expression: m[15] ?? "" },
        annotations: emptyIfUseless(ann),
      });
    } else if (m[16]) {
      // $singleToken$
      runs.push({
        type: "equation",
        equation: { expression: m[17] ?? "" },
        annotations: emptyIfUseless(ann),
      });
    }
    remaining = remaining.slice(m.index + m[0].length);
  }
  return runs.filter((r) => !(r.type === "text" && (r as { text: { content: string } }).text.content === ""));
}

// Parse standalone inline HTML (from marked's `html` / `tag` tokens) that isn't
// our extension set — most commonly `<br>` or a bare `<u>`.
function parseInlineHtml(html: string, ann: Annotations): RichTextRun[] {
  if (/^<br\s*\/?\s*>$/i.test(html)) return [textRun("\n", ann)];
  // Everything else: run it through the extension scanner so <u>/page/etc. handle.
  return scanExtensions(html, ann);
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function textRun(content: string, ann: Annotations, link?: string): RichTextRun {
  const run: RichTextRun = {
    type: "text",
    text: link ? { content, link: { url: link } } : { content },
    annotations: emptyIfUseless(ann),
  };
  return run;
}

function attachLink(run: RichTextRun, href: string): RichTextRun {
  if (run.type === "text") {
    return { ...run, text: { ...run.text, link: { url: href } } };
  }
  return run;
}

function emptyIfUseless(ann: Annotations): Annotations | undefined {
  const a: Annotations = {};
  if (ann.bold) a.bold = true;
  if (ann.italic) a.italic = true;
  if (ann.strikethrough) a.strikethrough = true;
  if (ann.underline) a.underline = true;
  if (ann.code) a.code = true;
  if (ann.color && ann.color !== "default") a.color = ann.color;
  return Object.keys(a).length > 0 ? a : undefined;
}

/** Merge consecutive text runs with identical annotations + no link. */
function mergeAdjacent(runs: RichTextRun[]): RichTextRun[] {
  const out: RichTextRun[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.type === "text" &&
      r.type === "text" &&
      !prev.text.link &&
      !r.text.link &&
      annotationsEqual(prev.annotations, r.annotations)
    ) {
      prev.text.content += r.text.content;
    } else {
      out.push(r);
    }
  }
  return out;
}

function annotationsEqual(a: Annotations | undefined, b: Annotations | undefined): boolean {
  const keys: Array<keyof Annotations> = ["bold", "italic", "strikethrough", "underline", "code", "color"];
  for (const k of keys) {
    if ((a?.[k] ?? false) !== (b?.[k] ?? false)) return false;
  }
  return true;
}

/** Break up runs whose content exceeds Notion's 2000-char per-run cap. */
function splitLongRuns(run: RichTextRun): RichTextRun[] {
  if (run.type !== "text") return [run];
  const content = run.text.content;
  if (content.length <= MAX_RUN_LENGTH) return [run];
  const out: RichTextRun[] = [];
  for (let i = 0; i < content.length; i += MAX_RUN_LENGTH) {
    const slice = content.slice(i, i + MAX_RUN_LENGTH);
    out.push({
      type: "text",
      text: run.text.link ? { content: slice, link: run.text.link } : { content: slice },
      annotations: run.annotations,
    });
  }
  return out;
}

/** marked escapes `<` / `&` / etc. in text tokens; undo those before handing to Notion. */
function unescapeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
