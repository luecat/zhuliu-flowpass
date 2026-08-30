const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function invalidTimestamp(fieldName: string): Error {
  return new Error(`${fieldName} must be a full RFC3339 timestamp with an explicit timezone`);
}

export function parseUtcRfc3339Timestamp(value: string, fieldName: string): string {
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) {
    throw invalidTimestamp(fieldName);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fractionalMilliseconds = Number(((match[7] ?? '').padEnd(3, '0')).slice(0, 3));
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw invalidTimestamp(fieldName);
  }

  const localCalendar = new Date(0);
  localCalendar.setUTCFullYear(year, month - 1, day);
  localCalendar.setUTCHours(hour, minute, second, fractionalMilliseconds);
  if (
    localCalendar.getUTCFullYear() !== year ||
    localCalendar.getUTCMonth() !== month - 1 ||
    localCalendar.getUTCDate() !== day ||
    localCalendar.getUTCHours() !== hour ||
    localCalendar.getUTCMinutes() !== minute ||
    localCalendar.getUTCSeconds() !== second
  ) {
    throw invalidTimestamp(fieldName);
  }

  const offsetMilliseconds = (offsetHour * 60 + offsetMinute) * 60_000;
  const signedOffsetMilliseconds = match[9] === '-' ? -offsetMilliseconds : offsetMilliseconds;
  return new Date(localCalendar.getTime() - signedOffsetMilliseconds).toISOString();
}
