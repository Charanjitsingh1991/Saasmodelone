import { describe, expect, test } from 'vitest';
import {
  csvField,
  csvRecord,
  PEOPLE_EXPORT_COLUMNS,
  PEOPLE_EXPORT_HEADER,
} from '@saasmodels/api';

describe('CSV helper', () => {
  test('writes the exact header with CRLF and no BOM', () => {
    expect(PEOPLE_EXPORT_COLUMNS).toEqual([
      'person_id',
      'employee_code',
      'first_name',
      'last_name',
      'display_name',
      'work_email',
      'phone',
    ]);
    expect(PEOPLE_EXPORT_HEADER).toBe(
      'person_id,employee_code,first_name,last_name,display_name,work_email,phone\r\n',
    );
    expect(PEOPLE_EXPORT_HEADER.startsWith('\uFEFF')).toBe(false);
  });

  test('writes null and empty values as empty fields', () => {
    expect(csvField(null)).toBe('');
    expect(csvField('')).toBe('');
    expect(csvRecord([null, ''])).toBe(',\r\n');
  });

  test('quotes commas, double quotes, LF and CRLF', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField('line\r\nbreak')).toBe('"line\r\nbreak"');
  });

  test('passes Unicode through unchanged', () => {
    expect(csvField('Zoë 李')).toBe('Zoë 李');
    expect(csvRecord(['Zoë 李', 'ok'])).toBe('Zoë 李,ok\r\n');
  });

  test.each([
    ['=', '=SUM(A1)', "'=SUM(A1)"],
    ['+', '+1', "'+1"],
    ['-', '-1', "'-1"],
    ['@', '@name', "'@name"],
    ['tab', '\tvalue', "'\tvalue"],
    ['CR', '\rvalue', '"\'\rvalue"'],
  ])('prefixes a formula-like value starting with %s', (_label, value, expected) => {
    expect(csvField(value)).toBe(expected);
  });

  test('only guards a formula character at the start of the value', () => {
    expect(csvField('a=b')).toBe('a=b');
    expect(csvField(' x')).toBe(' x');
  });

  test('joins fields in order and terminates the record with CRLF', () => {
    expect(csvRecord(['a', 'b,c', '"d"'])).toBe('a,"b,c","""d"""\r\n');
  });
});
