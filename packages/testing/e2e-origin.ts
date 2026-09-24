/** Each audit worktree may bind its own localhost port and isolated DB schema. */
export function e2ePort(value: string | undefined = process.env.FREEDOM_E2E_PORT): number {
  if (value === undefined) return 4311;
  if (!/^\d{4,5}$/.test(value)) throw Error('FREEDOM_E2E_PORT must be a localhost test port.');
  const port = Number(value);
  if (port < 1024 || port > 65535 || port === 4310 || port === 4312) {
    throw Error('FREEDOM_E2E_PORT must not use a deployed service port.');
  }
  return port;
}

export function e2eOrigin(): string {
  return `http://127.0.0.1:${e2ePort()}`;
}
