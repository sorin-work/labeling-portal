/**
 * Reads a raw request body, as the API's upload sends it, without taking in
 * more than `maxBytes`. Answers "too_large" as soon as the limit is passed.
 */
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | 'too_large'> {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > maxBytes) return 'too_large';
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      return 'too_large';
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/**
 * Reads a posted form without taking in more than `maxBytes` of it. The usual
 * `request.formData()` reads the whole body into memory before anything can
 * look at a file's size, so the limit has to be applied to the stream.
 * Answers "too_large" as soon as the limit is passed.
 */
export async function readBoundedForm(
  request: Request,
  maxBytes: number,
): Promise<FormData | 'too_large'> {
  const body = await readBoundedBody(request, maxBytes);
  if (body === 'too_large') return body;
  if (body.length === 0 && !request.body) return new FormData();
  return new Response(body, {
    headers: { 'Content-Type': request.headers.get('Content-Type') ?? '' },
  }).formData();
}
