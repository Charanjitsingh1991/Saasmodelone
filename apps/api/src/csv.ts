export const PEOPLE_EXPORT_COLUMNS = [
  'person_id',
  'employee_code',
  'first_name',
  'last_name',
  'display_name',
  'work_email',
  'phone',
] as const;

const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]/;

export function csvField(value: string | null): string {
  const text = value ?? '';
  const guarded = FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return NEEDS_QUOTING.test(guarded)
    ? `"${guarded.replaceAll('"', '""')}"`
    : guarded;
}

export function csvRecord(values: readonly (string | null)[]): string {
  return `${values.map(csvField).join(',')}\r\n`;
}

export const PEOPLE_EXPORT_HEADER = csvRecord(PEOPLE_EXPORT_COLUMNS);
