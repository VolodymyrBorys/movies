/**
 * The single date format of this API: RFC 3339 UTC text with MICROsecond precision
 * ("2026-11-19T10:00:00.123456Z"), independent of session TimeZone/DateStyle. Formatted in
 * SQL because a JS Date would drop the microseconds. NULL stays NULL.
 *
 * `column` is interpolated into SQL: pass only a column name from code, never user input.
 */
export function utcTimestampSql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
