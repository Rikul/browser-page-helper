// Minimal Markdown renderer for assistant replies.
// It builds DOM nodes with textContent and never uses innerHTML, so model
// output can't inject HTML or scripts. Links are limited to http(s) and mailto.
//
// Supports: paragraphs, headings, fenced code, inline code, bold, italic,
// strikethrough, links, bare URLs, lists (nested), blockquotes, tables, rules.
// Images are shown as links so remote images aren't loaded.

const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const FENCE_RE = /^ *(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}>/;
const TABLE_SEP_RE = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

export function renderMarkdown(src, target) {
  const lines = String(src)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^\t+/, (t) => "    ".repeat(t.length)));
  target.replaceChildren(...parseBlocks(lines));
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function inlineEl(tag, text) {
  const node = el(tag);
  node.append(...parseInline(text));
  return node;
}

const indentOf = (line) => line.match(/^ */)[0].length;

// ---------- Blocks ----------

function startsBlock(lines, i) {
  const line = lines[i];
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line) ||
    isTableStart(lines, i)
  );
}

function parseBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;

    if (!line.trim()) {
      i++;
    } else if ((m = line.match(FENCE_RE))) {
      const fence = m[1];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
      i++; // closing fence (missing while a reply is still streaming)
      const pre = el("pre");
      const codeEl = el("code", code.join("\n"));
      if (m[2]) codeEl.dataset.lang = m[2];
      pre.append(codeEl);
      out.push(pre);
    } else if ((m = line.match(HEADING_RE))) {
      out.push(inlineEl(`h${m[1].length}`, m[2]));
      i++;
    } else if (HR_RE.test(line)) {
      out.push(el("hr"));
      i++;
    } else if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        inner.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      }
      const quote = el("blockquote");
      quote.append(...parseBlocks(inner));
      out.push(quote);
    } else if (isTableStart(lines, i)) {
      const [table, next] = parseTable(lines, i);
      out.push(table);
      i = next;
    } else if (LIST_RE.test(line)) {
      const [list, next] = parseList(lines, i);
      out.push(list);
      i = next;
    } else {
      const para = [line.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
        para.push(lines[i++].trim());
      }
      out.push(inlineEl("p", para.join("\n")));
    }
  }
  return out;
}

function parseList(lines, i) {
  const first = lines[i].match(LIST_RE);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const list = el(ordered ? "ol" : "ul");
  const start = parseInt(first[2], 10);
  if (ordered && start !== 1) list.start = start;

  while (i < lines.length) {
    const m = lines[i].match(LIST_RE);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;

    // Collect the item's lines: its first line, then anything indented past
    // the marker (continuations, nested lists, code), plus blank lines between.
    const width = m[0].length - m[3].length;
    const body = [m[3]];
    let loose = false;
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        body.push("");
      } else if (indentOf(line) > indent) {
        body.push(line.slice(Math.min(width, indentOf(line))));
      } else {
        break;
      }
      i++;
    }
    while (body.length && !body[body.length - 1].trim()) body.pop();
    if (body.some((l) => !l.trim())) loose = true;

    const li = el("li");
    for (const node of parseBlocks(body)) {
      // Tight items show their text inline instead of in a <p>.
      if (!loose && node.tagName === "P") li.append(...node.childNodes);
      else li.append(node);
    }
    list.append(li);
  }
  return [list, i];
}

function isTableStart(lines, i) {
  return (
    lines[i].includes("|") &&
    i + 1 < lines.length &&
    lines[i + 1].includes("-") &&
    TABLE_SEP_RE.test(lines[i + 1])
  );
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function parseTable(lines, i) {
  const header = splitRow(lines[i]);
  const align = splitRow(lines[i + 1]).map((s) =>
    s.endsWith(":") ? (s.startsWith(":") ? "center" : "right") : s.startsWith(":") ? "left" : ""
  );
  const row = (cells, tag) => {
    const tr = el("tr");
    header.forEach((_, c) => {
      const cell = inlineEl(tag, cells[c] ?? "");
      if (align[c]) cell.style.textAlign = align[c];
      tr.append(cell);
    });
    return tr;
  };

  const table = el("table");
  const thead = el("thead");
  thead.append(row(header, "th"));
  const tbody = el("tbody");
  i += 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
    tbody.append(row(splitRow(lines[i++]), "td"));
  }
  table.append(thead, tbody);

  const wrap = el("div", null, "table-wrap"); // scrolls sideways if too wide
  wrap.append(table);
  return [wrap, i];
}

// ---------- Inline ----------

const LINK_URL = String.raw`<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?`;
const LINK_RE = new RegExp(String.raw`^(!?)\[([^\]]*)\]\(\s*${LINK_URL}(?:\s+"[^"]*")?\s*\)`);
const AUTOLINK_RE = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/;
const BARE_URL_RE = /^https?:\/\/[^\s<]*[^\s<.,:;"'!?)\]]/;

// [regex, tag(s)] — the first capture group is the inner text, parsed recursively.
const EMPHASIS = [
  [/^\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/, ["strong", "em"]],
  [/^\*\*(?=\S)([\s\S]*?\S)\*\*/, ["strong"]],
  [/^__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9])/, ["strong"], true],
  [/^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/, ["em"]],
  [/^_(?=\S)([\s\S]*?\S)_(?![A-Za-z0-9])/, ["em"], true],
  [/^~~(?=\S)([\s\S]*?\S)~~/, ["del"]],
];

function safeUrl(url) {
  try {
    const u = new URL(url);
    return ["http:", "https:", "mailto:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null; // relative or malformed
  }
}

function link(href, children) {
  const a = el("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.append(...children);
  return a;
}

function parseInline(text) {
  const out = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(document.createTextNode(buf));
    buf = "";
  };

  let i = 0;
  outer: while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);
    const prev = text[i - 1] || "";
    let m;

    if (ch === "\\" && /[\\`*_{}[\]()#+\-.!|~<>]/.test(text[i + 1] || "")) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`" && (m = rest.match(/^(`+)([\s\S]+?)\1(?!`)/))) {
      let code = m[2];
      if (/^ [\s\S]* $/.test(code) && code.trim()) code = code.slice(1, -1);
      flush();
      out.push(el("code", code));
      i += m[0].length;
      continue;
    }

    if ((ch === "[" || ch === "!") && (m = rest.match(LINK_RE))) {
      const [whole, bang, label, url] = m;
      const href = safeUrl(url);
      flush();
      if (href) {
        // Images become links so the panel doesn't fetch remote images.
        out.push(link(href, bang ? [document.createTextNode(label || href)] : parseInline(label)));
      } else {
        out.push(...parseInline(label));
      }
      i += whole.length;
      continue;
    }

    if (ch === "<" && (m = rest.match(AUTOLINK_RE))) {
      const href = safeUrl(m[1]);
      if (href) {
        flush();
        out.push(link(href, [document.createTextNode(m[1])]));
        i += m[0].length;
        continue;
      }
    }

    if (ch === "h" && !/[A-Za-z0-9]/.test(prev) && (m = rest.match(BARE_URL_RE))) {
      const href = safeUrl(m[0]);
      if (href) {
        flush();
        out.push(link(href, [document.createTextNode(m[0])]));
        i += m[0].length;
        continue;
      }
    }

    if (ch === "*" || ch === "_" || ch === "~") {
      for (const [re, tags, wordBound] of EMPHASIS) {
        if (wordBound && /[A-Za-z0-9]/.test(prev)) continue; // snake_case stays as is
        if ((m = rest.match(re))) {
          flush();
          const outerEl = el(tags[0]);
          let innerEl = outerEl;
          for (const t of tags.slice(1)) innerEl = innerEl.appendChild(el(t));
          innerEl.append(...parseInline(m[1]));
          out.push(outerEl);
          i += m[0].length;
          continue outer;
        }
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}
