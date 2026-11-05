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
