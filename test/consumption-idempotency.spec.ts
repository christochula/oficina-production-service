import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Actor } from '../src/auth';
import { Conflict, Envelope, InsufficientStock } from '../src/model';
import { ProductionService } from '../src/production.service';
import { MemoryStore } from './memory.store';

describe('Consumption receipts', () => {
  let store: MemoryStore; let service: ProductionService;
  const mechanic: Actor = { sub: 'm1', role: 'MECANICO' };
  async function prepare(osId = 'os1', filialId = 'f1') {
    await service.create({ osId, filialId, clienteId: 'c1' });
    await service.assign(osId, 'm1'); await service.diagnosis(osId, 'Trocar filtro');
    await service.stock(filialId, 'p1', 6);
    const message = (type: string, payload = {}): Envelope => ({ messageId: randomUUID(), type, version: 1, osId, filialId, sagaId: `saga-${osId}`, correlationId: osId, occurredAt: new Date().toISOString(), payload });
    await service.command(message('ReserveExecution', { budget: { version: 1, totalCents: 300, items: [{ description: 'Filtro', pecaId: 'p1', quantity: 3, unitPriceCents: 100 }] } }));
    await service.command(message('ConfirmExecution'));
    await service.start(osId, mechanic);
  }
  const consumedEvents = () => store.outbox.filter(item => item.event.type === 'PartsConsumed');
  beforeEach(async () => { store = new MemoryStore(); service = new ProductionService(store); await prepare(); });

  it('returns a replay without consuming or publishing twice and normalizes UUID case', async () => {
    const operationId = randomUUID();
    const first = await service.consume('os1', 'p1', 1, mechanic, operationId);
    const replay = await service.consume('os1', 'p1', 1, mechanic, operationId.toUpperCase());
    expect(replay).toEqual(first);
    expect(await store.getStock('f1', 'p1')).toMatchObject({ quantity: 3, reserved: 2, used: 1 });
    expect(consumedEvents()).toHaveLength(1); expect(store.consumptions.size).toBe(1);
  });

  it('concurrent requests with the same operation consume once', async () => {
    const operationId = randomUUID();
    const results = await Promise.all(Array.from({ length: 3 }, () => service.consume('os1', 'p1', 1, mechanic, operationId)));
    expect(results.every(order => order.parts[0].consumedQuantity === 1)).toBe(true);
    expect(consumedEvents()).toHaveLength(1);
    expect(await store.getStock('f1', 'p1')).toMatchObject({ reserved: 2, used: 1 });
  });

  it('rejects reuse for a different piece or quantity without changing the order', async () => {
    const operationId = randomUUID();
    const first = await service.consume('os1', 'p1', 1, mechanic, operationId);
    await expect(service.consume('os1', 'p1', 2, mechanic, operationId)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.consume('os1', 'other', 1, mechanic, operationId)).rejects.toBeInstanceOf(ConflictException);
    expect(await service.get('os1')).toEqual(first); expect(consumedEvents()).toHaveLength(1);
  });

  it('authorizes the caller before looking up a receipt', async () => {
    const operationId = randomUUID(); await service.consume('os1', 'p1', 1, mechanic, operationId);
    const lookup = jest.spyOn(store, 'getConsumptionReceipt');
    for (const actor of [{ sub: 'm2', role: 'MECANICO' }, { sub: 'c1', role: 'CLIENTE' }] as Actor[]) {
      await expect(service.consume('os1', 'p1', 1, actor, operationId)).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(lookup).not.toHaveBeenCalled(); expect(consumedEvents()).toHaveLength(1);
  });

  it('authorizes again if ownership changes before returning the current order', async () => {
    const operationId = randomUUID(); const first = await service.consume('os1', 'p1', 1, mechanic, operationId);
    jest.spyOn(store, 'getOrder').mockResolvedValueOnce(first).mockResolvedValueOnce({ ...first, mecanicoId: 'm2' });
    await expect(service.consume('os1', 'p1', 1, mechanic, operationId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(['', 'not-a-uuid', null])('rejects invalid operationId %p before writing a receipt', async operationId => {
    await expect(service.consume('os1', 'p1', 1, mechanic, operationId as unknown as string)).rejects.toBeInstanceOf(BadRequestException);
    expect(store.consumptions.size).toBe(0); expect(consumedEvents()).toHaveLength(0);
  });

  it('replays after completion without rejecting status or changing the completed aggregate', async () => {
    const operationId = randomUUID(); await service.consume('os1', 'p1', 3, mechanic, operationId);
    const completed = await service.complete('os1', mechanic);
    expect(await service.consume('os1', 'p1', 3, mechanic, operationId)).toEqual(completed);
    expect(await store.getStock('f1', 'p1')).toMatchObject({ reserved: 0, used: 3 });
    expect(consumedEvents()).toHaveLength(1);
  });

  it('allows a new operation and scopes the same UUID to a different OS and branch', async () => {
    const operationId = randomUUID(); await service.consume('os1', 'p1', 1, mechanic, operationId);
    await service.consume('os1', 'p1', 1, mechanic, randomUUID());
    await prepare('os2', 'f2'); await service.consume('os2', 'p1', 1, mechanic, operationId);
    expect((await service.get('os1')).parts[0].consumedQuantity).toBe(2);
    expect((await service.get('os2')).parts[0].consumedQuantity).toBe(1);
    expect(store.consumptions.size).toBe(3);
  });

  it('survives an unknown transport outcome after an atomic successful commit', async () => {
    const operationId = randomUUID(), commit = store.commit.bind(store);
    jest.spyOn(store, 'commit').mockImplementationOnce(async change => { await commit(change); throw new Error('Response lost after commit'); });
    await expect(service.consume('os1', 'p1', 1, mechanic, operationId)).rejects.toThrow('Response lost');
    expect((await service.consume('os1', 'p1', 1, mechanic, operationId)).parts[0].consumedQuantity).toBe(1);
    expect(consumedEvents()).toHaveLength(1);
  });

  it('rechecks a receipt when concurrent duplicate cancellation also reports exhausted stock', async () => {
    const operationId = randomUUID();
    jest.spyOn(store, 'commit').mockImplementationOnce(async () => {
      await service.consume('os1', 'p1', 3, mechanic, operationId);
      throw new InsufficientStock('Reservation exhausted by the winning duplicate');
    });
    expect((await service.consume('os1', 'p1', 3, mechanic, operationId)).parts[0].consumedQuantity).toBe(3);
    expect(consumedEvents()).toHaveLength(1);
  });

  it('does not write a receipt when stock or optimistic concurrency prevents the commit', async () => {
    store.stocks.get('f1#p1')!.reserved = 0;
    await expect(service.consume('os1', 'p1', 1, mechanic, randomUUID())).rejects.toBeInstanceOf(ConflictException);
    store.stocks.get('f1#p1')!.reserved = 3;
    jest.spyOn(store, 'commit').mockRejectedValue(new Conflict());
    await expect(service.consume('os1', 'p1', 1, mechanic, randomUUID())).rejects.toBeInstanceOf(ConflictException);
    expect(store.consumptions.size).toBe(0); expect(consumedEvents()).toHaveLength(0);
    expect((await service.get('os1')).parts[0].consumedQuantity).toBe(0);
  });
  it('explains a stale independent consumption when Dynamo also reports exhausted stock', async () => {
    const losingOperation = randomUUID();
    jest.spyOn(store, 'commit').mockImplementationOnce(async () => {
      await service.consume('os1', 'p1', 3, mechanic, randomUUID());
      throw new InsufficientStock('Reservation exhausted by an independent winner');
    });
    let rejection: BadRequestException | undefined;
    try { await service.consume('os1', 'p1', 3, mechanic, losingOperation); }
    catch (error) { rejection = error as BadRequestException; }
    expect(rejection?.getStatus()).toBe(400);
    expect(rejection?.getResponse()).toMatchObject({ code: 'QUANTITY_EXCEEDS_RESERVATION', definitive: true, quantidadeReservada: 3, quantidadeConsumida: 3, quantidadeRestante: 0 });
    expect(await store.getConsumptionReceipt('os1', losingOperation)).toBeUndefined();
    expect(await store.getStock('f1', 'p1')).toMatchObject({ reserved: 0, used: 3 });
    expect(consumedEvents()).toHaveLength(1);
  });
  it('returns a definitive excess rejection with reserved, consumed and remaining quantities without consuming', async () => {
    await service.consume('os1', 'p1', 1, mechanic, randomUUID());
    const before = await service.get('os1'), operationId = randomUUID();
    let rejection: BadRequestException | undefined;
    try { await service.consume('os1', 'p1', 3, mechanic, operationId); } catch (error) { rejection = error as BadRequestException; }
    expect(rejection?.getStatus()).toBe(400);
    expect(rejection?.getResponse()).toMatchObject({ code: 'QUANTITY_EXCEEDS_RESERVATION', definitive: true, pecaId: 'p1', filialId: 'f1', quantidadeSolicitada: 3, quantidadeReservada: 3, quantidadeConsumida: 1, quantidadeRestante: 2 });
    expect(await service.get('os1')).toEqual(before);
    expect(await store.getConsumptionReceipt('os1', operationId)).toBeUndefined();
    expect(await store.getStock('f1', 'p1')).toMatchObject({ reserved: 2, used: 1 });
    expect(consumedEvents()).toHaveLength(1);
  });
  it('rejects concurrent independent consumption beyond the reservation while leaving the winner replayable', async () => {
    const first = randomUUID(), second = randomUUID();
    const results = await Promise.allSettled([service.consume('os1', 'p1', 2, mechanic, first), service.consume('os1', 'p1', 2, mechanic, second)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.getResponse()).toMatchObject({ code: 'QUANTITY_EXCEEDS_RESERVATION', definitive: true, quantidadeReservada: 3, quantidadeConsumida: 2, quantidadeRestante: 1 });
    const winner = results[0].status === 'fulfilled' ? first : second;
    expect((await service.consume('os1', 'p1', 2, mechanic, winner)).parts[0].consumedQuantity).toBe(2);
    expect(consumedEvents()).toHaveLength(1);
  });
});
