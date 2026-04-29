/* eslint-disable no-console */
import 'server-only';
import { isAppError } from './errors';

const LOG_ALLOWLIST = new Set([
  'threadId',
  'userId',
  'bucket',
  'confidence',
  'action',
  'event',
  'level',
  'timestamp',
  'requestId',
  'durationMs',
  'statusCode',
  'attempt',
  'errorCode',
]);

type LogLevel = 'info' | 'warn' | 'error';
type LogPrimitive = string | number | boolean | null;
type LogFields = Record<string, unknown>;

function pickAllowlisted(fields: LogFields): Record<string, LogPrimitive> {
  const out: Record<string, LogPrimitive> = {};
  for (const key of Object.keys(fields)) {
    if (!LOG_ALLOWLIST.has(key)) continue;
    const value = fields[key];
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      out[key] = value;
    }
  }
  return out;
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  const record = pickAllowlisted({
    ...fields,
    event,
    level,
    timestamp: new Date().toISOString(),
  });
  const line = JSON.stringify(record);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info(event: string, fields: LogFields = {}): void {
    emit('info', event, fields);
  },

  warn(event: string, fields: LogFields = {}): void {
    emit('warn', event, fields);
  },

  error(event: string, fields: LogFields = {}, err?: unknown): void {
    const errFields: LogFields = {};
    if (isAppError(err)) {
      errFields.statusCode = err.statusCode;
    }
    emit('error', event, { ...fields, ...errFields });
  },
};
