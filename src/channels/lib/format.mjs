function getDisplayWidth(str) {
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 4352 && code <= 4447 || code >= 11904 && code <= 12350 || code >= 12352 && code <= 13247 || code >= 13312 && code <= 19903 || code >= 19968 && code <= 40959 || code >= 44032 && code <= 55215 || code >= 63744 && code <= 64255 || code >= 65072 && code <= 65103 || code >= 65280 && code <= 65376 || code >= 65504 && code <= 65510 || code >= 131072 && code <= 195103 || code >= 127744 && code <= 129535) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}
function replaceEmojiInCodeBlock(text) {
  return text.replace(/\u2705/g, "[O]").replace(/\u274C/g, "[X]").replace(/\u2B55/g, "[O]").replace(/\uD83D\uDD34/g, "[X]");
}
function convertMarkdownTables(text) {
  const lines = text.split("\n");
  const result = [];
  let i = 0;
  while (i < lines.length) {
    if (i > 0 && /^\|[\s-:]+(\|[\s-:]+)+\|?\s*$/.test(lines[i])) {
      const headerIdx = i - 1;
      const headerLine = lines[headerIdx];
      if (!/\|/.test(headerLine)) {
        result.push(lines[i]);
        i++;
        continue;
      }
      const tableLines = [headerLine];
      let j = i + 1;
      while (j < lines.length && /^\|/.test(lines[j]) && !/^\|[\s-:]+(\|[\s-:]+)+\|?\s*$/.test(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }
      const parseCells = (line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const allRows = tableLines.map(parseCells);
      const colCount = allRows[0].length;
      const widths = [];
      for (let c = 0; c < colCount; c++) {
        let max = 2;
        for (const row of allRows) {
          const cellLen = row[c] ? getDisplayWidth(row[c]) : 0;
          if (cellLen > max) max = cellLen;
        }
        widths.push(max);
      }
      const padCell = (str, w) => {
        const visLen = getDisplayWidth(str || "");
        return (str || "") + " ".repeat(Math.max(0, w - visLen));
      };
      const outLines = [];
      outLines.push(allRows[0].map((c, ci) => padCell(c, widths[ci])).join("  "));
      outLines.push(widths.map((w) => "-".repeat(w)).join("  "));
      for (let r = 1; r < allRows.length; r++) {
        outLines.push(allRows[r].map((c, ci) => padCell(c, widths[ci])).join("  "));
      }
      const tableText = replaceEmojiInCodeBlock(outLines.join("\n"));
      result[headerIdx] = "```\n" + tableText + "\n```";
      i = j;
      continue;
    }
    result.push(lines[i]);
    i++;
  }
  return result.join("\n");
}
function escapeNestedCodeBlocks(text) {
  let fenceLen = 0;
  const lines = text.split("\n");
  return lines.map((line) => {
    const match = line.match(/^(`{3,})/);
    if (match) {
      if (fenceLen === 0) {
        fenceLen = match[1].length;
      } else if (match[1].length >= fenceLen) {
        fenceLen = 0;
      }
      return line;
    }
    if (fenceLen > 0 && line.includes("```")) {
      return line.replace(/```/g, "`\u200B``");
    }
    return line;
  }).join("\n");
}
function formatForDiscord(text) {
  return escapeNestedCodeBlocks(convertMarkdownTables(text));
}
function safeCodeBlock(content, lang = "") {
  const escaped = content.replace(/```/g, "`\u200B``");
  return "```" + lang + "\n" + escaped + "\n```";
}
function chunk(text, limit = 2e3) {
  if (text.length <= limit) return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = -1;
    const cbEnd1 = rest.lastIndexOf("\n```\n", limit);
    const cbEnd2 = rest.lastIndexOf("\n```", limit);
    if (cbEnd1 > limit / 2) {
      cut = cbEnd1 + 4;
    } else if (cbEnd2 > limit / 2) {
      cut = cbEnd2 + 4;
    }
    if (cut <= 0 || cut > limit) {
      const para = rest.lastIndexOf("\n\n", limit);
      const line = rest.lastIndexOf("\n", limit);
      const space = rest.lastIndexOf(" ", limit);
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    }
    let part = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n+/, "");
    const backtickCount = (part.match(/```/g) || []).length;
    if (backtickCount % 2 === 1) {
      const langMatch = part.match(/```(\w+)/);
      const lang = langMatch ? langMatch[1] : "";
      const closing = "\n```";
      if (part.length + closing.length > limit) {
        const overflow = part.length + closing.length - limit;
        const moved = part.slice(part.length - overflow);
        part = part.slice(0, part.length - overflow) + closing;
        rest = "```" + lang + "\n" + moved + rest;
      } else {
        part += closing;
        rest = "```" + lang + "\n" + rest;
      }
    }
    out.push(part);
  }
  if (rest) out.push(rest);
  return out;
}
export {
  chunk,
  formatForDiscord,
  safeCodeBlock
};
