import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
import tracer from 'dd-trace';
import { Envelope, Store } from './model';
import { ProductionService } from './production.service';

export function parseEnvelope(raw: string): Envelope {
  const value = JSON.parse(raw);
  if (!value || value.version !== 1 || !['messageId', 'type', 'sagaId', 'osId', 'filialId', 'correlationId', 'occurredAt'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 200)
    || !Number.isFinite(Date.parse(value.occurredAt)) || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)
    || (value.traceparent !== undefined && !/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value.traceparent))) throw new Error('Invalid event envelope');
  return value;
}
@Injectable()
export class Messaging implements OnModuleInit, OnModuleDestroy {
  private readonly sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1', endpoint: process.env.AWS_ENDPOINT_URL });
  private readonly logger = new Logger(Messaging.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(private readonly store: Store, private readonly service: ProductionService) {}
  onModuleInit(): void {
    if (process.env.WORKER_ENABLED === 'false') return;
    this.timer = setInterval(() => { void this.tick(); }, 1000);
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.sqs.destroy(); }
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await this.publish(); await this.receive(); }
    catch (error: any) { this.logger.error(JSON.stringify({ operation: 'worker', error: error.message })); }
    finally { this.busy = false; }
  }
  async receive(): Promise<void> {
    const result = await this.sqs.send(new ReceiveMessageCommand({
      QueueUrl: process.env.INBOX_QUEUE_URL!, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 60,
    }));
    for (const item of result.Messages || []) {
      try {
        const event = parseEnvelope(item.Body || '');
        const parent = event.traceparent ? tracer.extract('http_headers', { traceparent: event.traceparent }) : null;
        await tracer.trace('production.command', { childOf: parent || undefined, tags: { 'saga.id': event.sagaId, 'os.id': event.osId, 'message.type': event.type } }, async () => this.service.command(event));
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: process.env.INBOX_QUEUE_URL!, ReceiptHandle: item.ReceiptHandle! }));
        this.logger.log(JSON.stringify({ operation: 'command', type: event.type, sagaId: event.sagaId, correlationId: event.correlationId, osId: event.osId }));
      } catch (error: any) { this.logger.error(JSON.stringify({ operation: 'receive', messageId: item.MessageId, error: error.message })); }
    }
  }
  async publish(): Promise<void> {
    for (const item of await this.store.pending()) {
      const owner = randomUUID();
      if (!(await this.store.claim(item.pk, owner))) continue;
      const queue = process.env.OS_QUEUE_URL!;
      await this.sqs.send(new SendMessageCommand({ QueueUrl: queue, MessageBody: JSON.stringify(item.event),
        ...(queue?.endsWith('.fifo') ? { MessageGroupId: item.event.osId, MessageDeduplicationId: item.event.messageId } : {}),
      }));
      await this.store.sent(item.pk, owner);
    }
  }
}
