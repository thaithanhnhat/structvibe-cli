export function print(value: unknown, json = false) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printError(error: unknown, json = false) {
  const payload = error instanceof Error
    ? {
        ok: false,
        code: "code" in error && typeof error.code === "string" ? error.code : "CLI_ERROR",
        error: error.message,
        ...(error && typeof error === "object" && "data" in error && error.data && typeof error.data === "object" ? error.data : {})
      }
    : { ok: false, code: "CLI_ERROR", error: String(error) };
  if (json) process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stderr.write(`Error [${payload.code}]: ${payload.error}\n`);
}
