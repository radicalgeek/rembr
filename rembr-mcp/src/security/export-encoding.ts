const SPREADSHEET_FORMULA_PREFIX = /^[\u0000-\u0020]*[=+\-@]/;

/** Encode one CSV cell and neutralise spreadsheet formula execution. */
export function encodeCsvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  text = text.replace(/\0/g, '');
  if (SPREADSHEET_FORMULA_PREFIX.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Keep untrusted values inside a Markdown table cell. */
export function encodeMarkdownCell(value: unknown): string {
  return (value == null ? '' : String(value))
    .replace(/\0/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, '<br>');
}

export function assertExportByteBudget(
  output: string,
  maximumBytes = 2 * 1024 * 1024,
): string {
  if (Buffer.byteLength(output, 'utf8') > maximumBytes) {
    throw new Error('Export exceeds the 2 MiB response limit; narrow the filter');
  }
  return output;
}
