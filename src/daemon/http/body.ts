export const DEFAULT_MAX_JSON_BODY_BYTES = 16 * 1024;

export type HttpInputErrorCode = "body-too-large" | "invalid-id" | "invalid-json";

export class HttpInputError extends Error {
  constructor(readonly code: HttpInputErrorCode) {
    super(code);
    this.name = "HttpInputError";
  }
}

export async function readJsonBody(request: Request, maxBytes = DEFAULT_MAX_JSON_BODY_BYTES): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) throw new HttpInputError("body-too-large");
  if (!request.body) throw new HttpInputError("invalid-json");

  const chunks: Uint8Array[] = [];
  const reader = request.body.getReader();
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new HttpInputError("body-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpInputError("invalid-json");
  }
}
