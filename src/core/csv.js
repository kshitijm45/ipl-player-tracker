/**
 * Minimal RFC4180 CSV parser.
 *
 * Hand-rolled rather than pulled from npm because the registry is the only CSV we
 * read and it needs exactly one non-trivial behaviour: quoted fields. Player names
 * in the Cricsheet register legitimately contain commas ("Jones, dev" style aliases
 * and comma-formatted names), so a naive split(',') corrupts the identity spine.
 */

export function parse(text) {
  const rows = parseRows(text);
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  return body
    .filter((cells) => cells.length > 1 || (cells[0] ?? '').trim() !== '')
    .map((cells) => {
      const obj = {};
      header.forEach((col, i) => {
        obj[col] = (cells[i] ?? '').trim();
      });
      return obj;
    });
}

function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      // Treat \r\n as one terminator.
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
