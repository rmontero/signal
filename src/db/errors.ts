export class PersistenceConflict extends Error {
  constructor(message: string) { super(message); this.name = "PersistenceConflict"; }
}

export function isUniqueViolation(error: unknown): boolean {
  return errorCode(error) === "23505";
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error) return error.code;
  if ("cause" in error) return errorCode(error.cause);
  return undefined;
}
