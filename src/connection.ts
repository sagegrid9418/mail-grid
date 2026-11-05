import type { Ports } from './types';

// Quote values for Laravel's phpdotenv, including literal $ and backslashes.
export function envValue(value: string) {
  // Laravel's env() casts reserved words and removes another pair of quotes.
  if (/^(?:true|false|empty|null|\((?:true|false|empty|null)\))$/i.test(value) || /^(['"])(.*)\1$/.test(value)) value = '"' + value + '"';
  if (/^[a-zA-Z0-9@._+-]+$/.test(value)) return value;
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
}
export function laravelConfig(address: string, password: string, ports: Ports) {
  return [
    'MAIL_MAILER=smtp', 'MAIL_SCHEME=smtp', 'MAIL_HOST=127.0.0.1', `MAIL_PORT=${ports.smtp}`,
    `MAIL_USERNAME=${envValue(address)}`, `MAIL_PASSWORD=${envValue(password)}`,
    `MAIL_FROM_ADDRESS=${envValue(address)}`, 'MAIL_FROM_NAME="${APP_NAME}"',
  ].join('\n');
}
