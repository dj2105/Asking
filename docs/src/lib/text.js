export function normaliseText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s+([?!.,;:])/g, "$1")
    .trim();
}

export function toBalancedLines(value, { minWordsPerLine = 2, maxLines = 2 } = {}) {
  const clean = normaliseText(value);
  if (!clean) return [];

  const words = clean.split(" ");
  if (maxLines <= 1 || words.length < minWordsPerLine * maxLines) {
    return [clean];
  }

  if (maxLines === 2) {
    let bestSplit = null;
    for (let split = minWordsPerLine; split <= words.length - minWordsPerLine; split += 1) {
      const leftWords = words.slice(0, split);
      const rightWords = words.slice(split);
      if (leftWords.length < minWordsPerLine || rightWords.length < minWordsPerLine) continue;

      const leftText = leftWords.join(" ");
      const rightText = rightWords.join(" ");
      const leftLen = leftText.length;
      const rightLen = rightText.length;
      const diff = Math.abs(leftLen - rightLen);
      const worst = Math.max(leftLen, rightLen);

      if (!bestSplit || diff < bestSplit.diff || (diff === bestSplit.diff && worst < bestSplit.worst)) {
        bestSplit = { diff, worst, lines: [leftText, rightText] };
      }
    }

    if (bestSplit) {
      return bestSplit.lines.filter(Boolean);
    }
  }

  return [clean];
}

export function setMultilineText(target, lines) {
  if (!target) return;
  const sequence = Array.isArray(lines) ? lines : [normaliseText(lines)];
  target.textContent = "";
  sequence.filter(Boolean).forEach((line, index) => {
    if (index > 0) target.appendChild(document.createElement("br"));
    target.appendChild(document.createTextNode(line));
  });
}
