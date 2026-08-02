export class SessionMigrationCommitError extends Error {
  readonly code = "session_binding_unavailable";

  constructor(cause?: unknown) {
    super("session_binding_unavailable", { cause });
    this.name = "SessionMigrationCommitError";
  }
}

export interface MigrationCommitter {
  commit(): Promise<{ readonly code: string }>;
}

export type CompleteResponseValidator = (input: {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}) => Promise<boolean> | boolean;

function unavailableResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: "service_unavailable",
        code: "session_binding_unavailable",
        message: "session_binding_unavailable",
      },
    }),
    {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "1" },
    }
  );
}

async function commitOrUnavailable(committer: MigrationCommitter): Promise<Response | null> {
  try {
    const result = await committer.commit();
    return result.code === "applied" ? null : unavailableResponse();
  } catch {
    return unavailableResponse();
  }
}

export async function commitBufferedMigrationResponse(input: {
  readonly upstream: Response;
  readonly validate: CompleteResponseValidator;
  readonly committer: MigrationCommitter;
}): Promise<Response> {
  const body = new Uint8Array(await input.upstream.arrayBuffer());
  if (
    !(await input.validate({
      status: input.upstream.status,
      headers: input.upstream.headers,
      body,
    }))
  ) {
    return unavailableResponse();
  }
  const unavailable = await commitOrUnavailable(input.committer);
  if (unavailable) return unavailable;
  return new Response(body, {
    status: input.upstream.status,
    statusText: input.upstream.statusText,
    headers: input.upstream.headers,
  });
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function commitStreamingMigrationResponse(input: {
  readonly upstream: Response;
  readonly isProtocolValidPrefix: (bytes: Uint8Array) => boolean;
  readonly committer: MigrationCommitter;
  readonly maximumPrebufferBytes?: number;
}): Promise<Response> {
  if (!input.upstream.body) return unavailableResponse();
  const reader = input.upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  const maximum = input.maximumPrebufferBytes ?? 256 * 1024;
  let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();
  while (!input.isProtocolValidPrefix(buffered)) {
    const next = await reader.read();
    if (next.done) {
      await reader.cancel().catch(() => undefined);
      return unavailableResponse();
    }
    chunks.push(next.value);
    buffered = concatenate(chunks);
    if (buffered.byteLength > maximum) {
      await reader.cancel().catch(() => undefined);
      return unavailableResponse();
    }
  }

  const unavailable = await commitOrUnavailable(input.committer);
  if (unavailable) {
    await reader.cancel().catch(() => undefined);
    return unavailable;
  }

  let emittedPrefix = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!emittedPrefix) {
        emittedPrefix = true;
        controller.enqueue(buffered);
        return;
      }
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: input.upstream.status,
    statusText: input.upstream.statusText,
    headers: input.upstream.headers,
  });
}

export function containsCompleteSseEvent(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes);
  const boundary = text.indexOf("\n\n");
  if (boundary < 0) return false;
  const event = text.slice(0, boundary);
  return event.split("\n").some((line) => line.startsWith("data:") && line.slice(5).trim());
}
