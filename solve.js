// Faster drop-in for csv-reader 1.0.0.
//
// Same answers, same error records, same order. Written from the published
// behaviour spec (competition.yaml / RULES.txt), not from any existing reader.
//
// Idea: never walk the text one character at a time. The bulk of a file is
// plain records, so a whole plain record is cut out with indexOf and split
// in one go (V8 does both in native code). Only records that actually hold a
// quote or a stray CR fall back to field-by-field parsing, and there each
// field is cut out with indexOf jumps to its next delimiter instead of a
// per-character loop. Quoted fields are sliced whole; the "" -> " and
// CR/CRLF -> LF rewrites only run when the slice actually contains them.
//
// Behaviour, per the spec:
//  - U+FEFF at the very start is dropped.
//  - A record ends at LF or CRLF; a line with no characters is no record.
//  - Outside quotes a CR not followed by LF is dropped (stray_cr).
//  - A field opening with a quote runs to the next non-doubled quote; ""
//    inside is one quote; CRLF / lone CR inside read as LF. What follows the
//    closing quote up to the next comma or line break is appended as-is
//    (quote_junk, when the field ends). A quote that never closes is a
//    literal character and the text after it is re-read as unquoted
//    (unterminated_quote). A quote inside an unquoted field is literal.
//  - Fields stay strings, never trimmed or converted.
//  - columns is the first record when header is true, else null; rows are
//    the records after it (every record when header is false), each padded
//    with "" (short_row, with fields: its field count) or cut (long_row,
//    with extra: the cut fields) to the first record's width.
//  - Each error is {code, line, row}, in the order met; a record's
//    short_row / long_row when it ends. line is the 1-based line its record
//    starts on, counting every LF, CRLF and lone CR inside quotes; row is
//    its record's index in rows, null for the header.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

const C_COMMA = 44; // ,
const C_QUOTE = 34; // "
const C_LF = 10;
const C_CR = 13;
const C_BOM = 0xfeff;

/** csv-reader 1.0.0's answer for one case's input: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === C_BOM) pos = 1;

  // The record being read: the line it starts on, its index in rows (null:
  // the header). Field helpers below read these at the moment an error is
  // recorded, so they always name the current record.
  let recordLine = 1;
  let recordRow = null;

  // The field just parsed, set by the scan helpers: its value, how it
  // ended (COMMA / LINE_BREAK / END) and, for a quoted field's junk tail,
  // how many junk characters were appended.
  let fv = '';
  let fe = END;
  let fa = 0;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Scan an unquoted field starting at pos, with `init` as its starting
  // value ("" normally, or the quoted value when reading a junk tail, or
  // '"' when re-reading after an unterminated quote). Sets fv / fe / fa.
  // fa counts only the characters appended here, never `init`.
  //
  // Fast lane: the field almost always ends at a comma or LF with no CR
  // before it, so find those two delimiters first and only look for a CR
  // inside the cut-out slice. A CR anywhere in the slice (other than the
  // single CR of a CRLF terminator) falls back to the general scan, which
  // drops each lone CR with a stray_cr error in order.
  function scanUnquoted(init) {
    const p = pos;
    const ci = text.indexOf(',', p);
    const ni = text.indexOf('\n', p);
    let m;
    let kind;
    if (ci !== -1 && (ni === -1 || ci < ni)) { m = ci; kind = 1; }
    else if (ni !== -1) { m = ni; kind = 2; }
    else m = -1;
    const ri = text.indexOf('\r', p);
    if (m === -1) {
      if (ri === -1) {
        fv = init + text.slice(p); fa = n - p; pos = n; fe = END;
        return;
      }
      scanUnquotedSlow(init);
      return;
    }
    if (ri !== -1 && ri < m) {
      if (kind === 2 && ri === m - 1) {
        fv = init + text.slice(p, m - 1); fa = m - 1 - p;
        pos = m + 1; line += 1; fe = LINE_BREAK;
        return;
      }
      scanUnquotedSlow(init);
      return;
    }
    fv = init + text.slice(p, m); fa = m - p;
    if (kind === 1) { pos = m + 1; fe = COMMA; }
    else { pos = m + 1; line += 1; fe = LINE_BREAK; }
  }

  // General unquoted scan: same result as scanUnquoted, dropping each
  // lone CR (stray_cr) in order. Only used when the field holds a CR.
  function scanUnquotedSlow(init) {
    let v = init;
    let added = 0;
    let p = pos;
    for (;;) {
      const ci = text.indexOf(',', p);
      const ni = text.indexOf('\n', p);
      const ri = text.indexOf('\r', p);
      let m = -1;
      let kind = 0; // 1 comma, 2 LF, 3 CR
      if (ci !== -1 && (m === -1 || ci < m)) { m = ci; kind = 1; }
      if (ni !== -1 && (m === -1 || ni < m)) { m = ni; kind = 2; }
      if (ri !== -1 && (m === -1 || ri < m)) { m = ri; kind = 3; }
      if (m === -1) {
        if (p < n) { v += text.slice(p); added += n - p; }
        pos = n;
        fv = v; fe = END; fa = added;
        return;
      }
      if (kind === 1) {
        v += text.slice(p, m); added += m - p;
        pos = m + 1;
        fv = v; fe = COMMA; fa = added;
        return;
      }
      if (kind === 2) {
        v += text.slice(p, m); added += m - p;
        pos = m + 1;
        line += 1;
        fv = v; fe = LINE_BREAK; fa = added;
        return;
      }
      // A CR: CRLF ends the record, a lone CR is dropped (stray_cr).
      if (text.charCodeAt(m + 1) === C_LF) {
        v += text.slice(p, m); added += m - p;
        pos = m + 2;
        line += 1;
        fv = v; fe = LINE_BREAK; fa = added;
        return;
      }
      v += text.slice(p, m); added += m - p;
      pushError('stray_cr');
      p = m + 1;
      pos = p;
    }
  }

  // Scan a quoted field whose opening quote is at pos. Sets fv / fe / fa
  // (fa is the junk-tail length, 0 when the field ends cleanly).
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    // Find the closing quote: the first '"' not followed by another '"'.
    let q = text.indexOf('"', open + 1);
    let closed = -1;
    let hasDouble = false;
    while (q !== -1) {
      if (text.charCodeAt(q + 1) === C_QUOTE) {
        hasDouble = true;
        q = text.indexOf('"', q + 2);
        continue;
      }
      closed = q;
      break;
    }
    if (closed === -1) {
      // Never closes: the quote is literal, the text after it is re-read
      // as an unquoted field, with the line count rolled back to the open.
      pos = open + 1;
      line = openLine;
      pushError('unterminated_quote');
      scanUnquoted('"');
      return;
    }
    const segStart = open + 1;
    const segEnd = closed;
    let value;
    const lfAt = text.indexOf('\n', segStart);
    const hasLF = lfAt !== -1 && lfAt < segEnd;
    const crAt = text.indexOf('\r', segStart);
    const hasCR = crAt !== -1 && crAt < segEnd;
    if (!hasCR && !hasDouble) {
      // Plain quoted slice: no rewrite, just count its line breaks.
      value = text.slice(segStart, segEnd);
      if (hasLF) {
        let c = 0;
        let p = segStart;
        for (;;) {
          p = text.indexOf('\n', p);
          if (p === -1 || p >= segEnd) break;
          c += 1;
          p += 1;
        }
        line += c;
      }
    } else {
      // Rewrite pass over the slice only: "" -> ", CRLF / CR -> LF, and
      // every line break inside counts once.
      const parts = [];
      let chunk = segStart;
      let i = segStart;
      while (i < segEnd) {
        const ch = text.charCodeAt(i);
        if (ch === C_QUOTE) {
          parts.push(text.slice(chunk, i));
          parts.push('"');
          i += 2;
          chunk = i;
        } else if (ch === C_CR) {
          parts.push(text.slice(chunk, i));
          parts.push('\n');
          line += 1;
          i += text.charCodeAt(i + 1) === C_LF ? 2 : 1;
          chunk = i;
        } else {
          if (ch === C_LF) line += 1;
          i += 1;
        }
      }
      parts.push(text.slice(chunk, segEnd));
      value = parts.join('');
    }
    pos = closed + 1;
    if (pos >= n) { fv = value; fe = END; fa = 0; return; }
    const c = text.charCodeAt(pos);
    if (c === C_COMMA) { pos += 1; fv = value; fe = COMMA; fa = 0; return; }
    if (c === C_LF) { pos += 1; line += 1; fv = value; fe = LINE_BREAK; fa = 0; return; }
    if (c === C_CR && text.charCodeAt(pos + 1) === C_LF) {
      pos += 2; line += 1; fv = value; fe = LINE_BREAK; fa = 0; return;
    }
    // Junk after the closing quote: appended as it stands, up to the next
    // comma or line break. Its stray_cr errors come first, quote_junk
    // after them, only when junk characters were actually appended.
    scanUnquoted(value);
    if (fa > 0) pushError('quote_junk');
  }

  // Finish one record: blank single empty unquoted fields are no record;
  // otherwise the first record sets the width (and the columns when there
  // is a header), later records are padded or cut to it.
  function finishRecord(fields, lastQuoted) {
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === C_LF) { pos += 1; line += 1; }
      else if (c === C_CR && text.charCodeAt(pos + 1) === C_LF) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a whole record with no quote and no stray CR. Its line
    // is cut out with indexOf and split in native code. A trailing CR is
    // only the CRLF terminator when a LF really follows it.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    const qAt = text.indexOf('"', pos);
    if (qAt === -1 || qAt >= lineEnd) {
      const rAt = text.indexOf('\r', pos);
      if (rAt === -1 || rAt >= lineEnd || (nl !== -1 && rAt === lineEnd - 1)) {
        const end = nl !== -1 && rAt === lineEnd - 1 ? lineEnd - 1 : lineEnd;
        const fields = text.slice(pos, end).split(',');
        pos = nl === -1 ? n : nl + 1;
        if (nl !== -1) line += 1;
        finishRecord(fields, false);
        continue;
      }
    }

    // Slow path: field by field.
    const fields = [];
    let lastQuoted = false;
    for (;;) {
      lastQuoted = text.charCodeAt(pos) === C_QUOTE;
      if (lastQuoted) scanQuoted();
      else scanUnquoted('');
      fields.push(fv);
      if (fe !== COMMA) break;
    }
    finishRecord(fields, lastQuoted);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
