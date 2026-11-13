import tracer from 'dd-trace';

/** Continue the current HTTP/consumer span when constructing a durable message. */
export function activeTraceparent(fallback?: string): string | undefined {
  try {
    const span=tracer.scope().active();
    if (span) {
      const carrier: Record<string,string>={};
      tracer.inject(span,'http_headers',carrier);
      if (carrier.traceparent) return carrier.traceparent;
    }
  } catch { /* Missing telemetry must never prevent a transaction. */ }
  return fallback;
}

interface TraceableMessage {
  messageId: string; type: string; osId: string; sagaId: string; correlationId: string; traceparent?: string;
}

/** Attach delayed SDK publishing to the trace persisted with the transaction. */
export async function traceOutbox<T extends TraceableMessage>(name: string, message: T, publish: (outgoing: T) => Promise<void>): Promise<void> {
  let parent: ReturnType<typeof tracer.extract> = null;
  try { if (message.traceparent) parent = tracer.extract('http_headers', { traceparent: message.traceparent }); }
  catch { /* Missing trace context must not discard durable work. */ }
  await tracer.trace(name, { childOf: parent || undefined, resource: message.type, tags: {
    'span.kind': 'producer', 'messaging.system': 'aws_sqs', 'messaging.message_id': message.messageId,
    'message.type': message.type, 'saga.id': message.sagaId, 'os.id': message.osId, 'correlation.id': message.correlationId,
  } }, async () => publish({ ...message, traceparent: activeTraceparent(message.traceparent) }));
}

export function withTraceIds(record: Record<string, unknown>): Record<string, unknown> {
  try { const active = tracer.scope().active(); if (active) tracer.inject(active, 'log', record); }
  catch { /* Logging remains available with tracing disabled. */ }
  return record;
}
