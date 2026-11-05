jest.mock('dd-trace', () => ({ __esModule:true, default:{ scope:()=>({active:()=>null}), inject:jest.fn(), extract:jest.fn(()=>({trace:'parent'})), trace:jest.fn((_name,_options,fn)=>fn()) } }));
import { Logger } from '@nestjs/common';
import { Messaging, parseEnvelope } from '../src/messaging';
import { ProductionService } from '../src/production.service';
import { MemoryStore } from './memory.store';
import { Envelope } from '../src/model';
const event: Envelope = { messageId:'m1',type:'CancelExecutionReservation',version:1,sagaId:'s1',osId:'o1',filialId:'f1',correlationId:'c1',occurredAt:'2026-11-04T12:00:00Z',payload:{} };
describe('SQS durability, retry and shutdown', () => {
  let store: MemoryStore; let service: ProductionService; let worker: Messaging; let send: jest.Mock;
  beforeEach(() => {
    store=new MemoryStore(); service=new ProductionService(store); worker=new Messaging(store,service);
    send=jest.fn().mockResolvedValue({}); (worker as any).sqs={send,destroy:jest.fn()};
    jest.spyOn(Logger.prototype,'error').mockImplementation(()=>{}); jest.spyOn(Logger.prototype,'log').mockImplementation(()=>{});
  });
  afterEach(()=>{ worker.onModuleDestroy(); jest.restoreAllMocks(); jest.useRealTimers(); delete process.env.WORKER_ENABLED; });
  it('validates message envelopes before processing and rejects malformed poison messages', () => {
    expect(parseEnvelope(JSON.stringify(event))).toEqual(event);
    for (const value of [null,{}, {...event,version:2}, {...event,payload:[]}, {...event,osId:''}, {...event,occurredAt:'bad'}, {...event,traceparent:'bad'}, {...event,payload:null}]) expect(()=>parseEnvelope(JSON.stringify(value))).toThrow();
    expect(()=>parseEnvelope('bad JSON')).toThrow();
  });
  it('acknowledges only after transactional command succeeds and propagates tracing', async () => {
    const command = jest.spyOn(service,'command');
    send.mockResolvedValueOnce({Messages:[{Body:JSON.stringify({...event,traceparent:'00-01234567890123456789012345678901-0123456789012345-01'}),ReceiptHandle:'receipt',MessageId:'aws1'}]});
    await worker.receive(); expect(command).toHaveBeenCalledTimes(1); expect(store.keys.has('CANCELLED#s1')).toBe(true);
    expect(send.mock.calls[1][0].constructor.name).toBe('DeleteMessageCommand');
  });
  it('leaves invalid and transiently failed messages unacknowledged for retry/DLQ', async () => {
    send.mockResolvedValueOnce({Messages:[{Body:'invalid',MessageId:'bad'}, {Body:undefined,MessageId:'empty'}, {Body:JSON.stringify(event),MessageId:'transient'}]});
    jest.spyOn(service,'command').mockRejectedValueOnce(new Error('database unavailable'));
    await worker.receive(); expect(send).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.error).toHaveBeenCalledTimes(3);
    await worker.receive(); // empty SQS response
  });
  it('publishes durable outbox and marks sent only after successful send', async () => {
    await service.command(event); const sent=jest.spyOn(store,'sent');
    await worker.publish(); expect(sent).toHaveBeenCalled(); expect(store.outbox).toHaveLength(0);
    expect(send.mock.calls[0][0].input.MessageBody).toContain('ExecutionCancelled');
  });
  it('skips records leased elsewhere and preserves unsent records if network fails', async () => {
    await service.command(event); const claim=jest.spyOn(store,'claim').mockResolvedValueOnce(false);
    await worker.publish(); expect(send).not.toHaveBeenCalled(); expect(store.outbox).toHaveLength(1);
    claim.mockResolvedValue(true); send.mockRejectedValueOnce(new Error('SQS offline'));
    await expect(worker.publish()).rejects.toThrow('SQS offline'); expect(store.outbox).toHaveLength(1);
  });
  it('does not overlap ticks, recovers after failure, honors worker disabled and cleans up timer', async () => {
    let finish!:()=>void;
    const publish=jest.spyOn(worker,'publish').mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const receive=jest.spyOn(worker,'receive').mockResolvedValue();
    const first=worker.tick(); await worker.tick(); expect(publish).toHaveBeenCalledTimes(1); finish(); await first;
    publish.mockRejectedValueOnce(new Error('retry later')); await worker.tick();
    expect(Logger.prototype.error).toHaveBeenCalled(); await worker.tick(); expect(receive).toHaveBeenCalledTimes(2);
    jest.useFakeTimers(); process.env.WORKER_ENABLED='false'; worker.onModuleInit(); expect(jest.getTimerCount()).toBe(0);
    process.env.WORKER_ENABLED='true'; worker.onModuleInit(); expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(1000); await Promise.resolve(); worker.onModuleDestroy(); expect(jest.getTimerCount()).toBe(0);
  });
});
