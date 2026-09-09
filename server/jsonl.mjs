/**
 * LF-only JSONL framing. Both pi's RPC protocol and the session files use "\n" as
 * the sole record delimiter; U+2028/U+2029 are legal inside JSON strings, so a
 * generic readline is NOT safe here.
 */
export function createLineSplitter(onLine) {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.trim()) onLine(line);
      }
    },
    flush() {
      const line = buf.endsWith("\r") ? buf.slice(0, -1) : buf;
      buf = "";
      if (line.trim()) onLine(line);
    },
    get pending() {
      return buf;
    },
  };
}

export function parseJsonLines(text) {
  const out = [];
  const s = createLineSplitter((line) => {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
  });
  s.push(text);
  s.flush();
  return out;
}
