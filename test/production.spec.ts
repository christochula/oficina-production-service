import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ProductionService } from '../src/production.service';
import { Conflict, Envelope, InsufficientStock } from '../src/model';
import { MemoryStore } from './memory.store';

export const message = (type: string, payload: object = {}, osId = 'os1', sagaId = 'saga1'): Envelope => ({
  messageId: randomUUID(), type, version: 1, osId, sagaId, filialId: 'f1', correlationId: 'corr1', occurredAt: new Date().toISOString(), payload,
});
const budget = { version: 1, items: [{ description: 'Filtro', quantity: 2, unitPriceCents: 100, pecaId: 'p1' }], totalCents: 200 };
describe('Production transaction lifecycle', () => {
  let store: MemoryStore; let service: ProductionService;
  beforeEach(() => { store = new MemoryStore(); service = new ProductionService(store); delete process.env.ENABLE_DEMO_FAILURES; });
  async function diagnosed() {
    await service.create({ osId: 'os1', filialId: 'f1', clienteId: 'c1' });
    await service.assign('os1', 'm1'); await service.diagnosis('os1', 'Trocar filtro');
    await service.stock('f1', 'p1', 5);
  }
  async function reserved() { await diagnosed(); await service.command(message('ReserveExecution', { budget })); }
  async function ready() { await reserved(); await service.command(message('ConfirmExecution')); }
  it('runs diagnosis → reservation → confirmation → execution → consumption → completion atomically', async () => {
    await ready(); expect((await service.get('os1')).status).toBe('READY');
    expect((await store.getStock('f1', 'p1'))).toMatchObject({ quantity: 3, reserved: 2, used: 0 });
    await service.start('os1'); await service.consume('os1', 'p1', 1); await service.consume('os1', 'p1', 1);
    expect((await service.complete('os1')).status).toBe('COMPLETED');
    expect((await store.getStock('f1', 'p1'))).toMatchObject({ quantity: 3, reserved: 0, used: 2 });
    expect(store.outbox.map(x => x.event.type)).toEqual(['MechanicAssigned', 'DiagnosisRecorded', 'ExecutionReserved', 'ExecutionReady', 'ExecutionStarted', 'PartsConsumed', 'PartsConsumed', 'ProductionCompleted']);
  });
  it('retries internal creation without resetting existing state and rejects ownership mismatch', async () => {
    await diagnosed(); const first = await service.get('os1');
    expect(await service.create({ osId: 'os1', filialId: 'f1', clienteId: 'c1', mecanicoId: 'other' })).toEqual(first);
    await expect(service.create({ osId: 'os1', filialId: 'f2', clienteId: 'c1' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.create({ osId: 'os1', filialId: 'f1', clienteId: 'c2' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.get('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(await service.list('f2')).toEqual([]); expect(await service.list()).toHaveLength(1);
  });
  it('retries a concurrent creator but propagates unexpected database failures', async () => {
    const spy = jest.spyOn(store, 'commit').mockRejectedValueOnce(new Conflict());
    expect((await service.create({ osId: 'os1', filialId: 'f1', clienteId: 'c1' })).status).toBe('DIAGNOSIS');
    spy.mockRejectedValueOnce(new Error('offline'));
    await expect(service.create({ osId: 'os2', filialId: 'f1', clienteId: 'c1' })).rejects.toThrow('offline');
  });
  it('deduplicates message ID and saga step even when producer uses a different message ID', async () => {
    await diagnosed(); const cmd = message('ReserveExecution', { budget });
    await service.command(cmd); await service.command(cmd); await service.command({ ...cmd, messageId: 'different' });
    expect(store.outbox.filter(x => x.event.type === 'ExecutionReserved')).toHaveLength(1);
    expect((await store.getStock('f1', 'p1'))?.quantity).toBe(3);
  });
  it.each(['RESERVED', 'READY'])('compensates %s reservation with stock restored, and blocks late confirmation', async state => {
    if (state === 'RESERVED') await reserved(); else await ready();
    await service.command(message('CancelExecutionReservation'));
    expect((await service.get('os1')).status).toBe('CANCELLED');
    expect((await store.getStock('f1', 'p1'))).toMatchObject({ quantity: 5, reserved: 0 });
    await service.command(message('ConfirmExecution'));
    expect((await service.get('os1')).status).toBe('CANCELLED');
  });
  it('persists cancellation tombstone even if creation/reservation has not arrived', async () => {
    await service.command(message('CancelExecutionReservation'));
    expect(store.keys.has('CANCELLED#saga1')).toBe(true);
    expect(store.outbox[0].event.type).toBe('ExecutionCancelled');
    await diagnosed(); await service.command(message('ReserveExecution', { budget }));
    expect((await service.get('os1')).status).toBe('DIAGNOSIS');
    expect(store.outbox.at(-1)?.event).toMatchObject({ type: 'CommandFailed', payload: { reason: 'Saga already cancelled' } });
  });
  it('allows explicit retry with a new saga after compensation while rejecting old saga messages',async()=>{
    await reserved();await service.command(message('CancelExecutionReservation'));
    await service.command(message('ReserveExecution',{budget},'os1','saga2'));
    expect((await service.get('os1')).status).toBe('RESERVED');expect((await service.get('os1')).sagaId).toBe('saga2');
    await service.command(message('ConfirmExecution',{},'os1','saga1'));
    expect((await service.get('os1')).status).toBe('RESERVED');expect((await store.getStock('f1','p1'))?.reserved).toBe(2);
  });
  it('compensates repeated attempts with insufficient stock, then reserves after replenishment', async () => {
    await diagnosed(); await service.stock('f1', 'p1', 0);
    for (const sagaId of ['saga1', 'saga2', 'saga3']) {
      await service.command(message('ReserveExecution', { budget }, 'os1', sagaId));
      expect(store.outbox.at(-1)?.event).toMatchObject({ type: 'CommandFailed', sagaId, payload: { reason: 'Insufficient stock or reservation' } });
      const cancellation = message('CancelExecutionReservation', {}, 'os1', sagaId);
      await service.command(cancellation);
      expect(store.outbox.at(-1)?.event).toMatchObject({ type: 'ExecutionCancelled', sagaId });
      expect((await service.get('os1'))).toMatchObject({ status: 'CANCELLED', sagaId });
      expect(store.keys.has(`CANCELLED#${sagaId}`)).toBe(true);
      expect(await store.getStock('f1', 'p1')).toMatchObject({ quantity: 0, reserved: 0, used: 0 });
      const count = store.outbox.length;
      await service.command(cancellation);
      await service.command({ ...cancellation, messageId: randomUUID() });
      expect(store.outbox).toHaveLength(count);
    }
    await store.addStock('f1', 'p1', 2);
    await service.command(message('ReserveExecution', { budget }, 'os1', 'saga4'));
    await service.command(message('ConfirmExecution', {}, 'os1', 'saga4'));
    expect(await service.get('os1')).toMatchObject({ status: 'READY', sagaId: 'saga4' });
    expect(await store.getStock('f1', 'p1')).toMatchObject({ quantity: 0, reserved: 2, used: 0 });
    for (const sagaId of ['saga1', 'saga2', 'saga3']) {
      await service.command(message('ConfirmExecution', {}, 'os1', sagaId));
      expect(await service.get('os1')).toMatchObject({ status: 'READY', sagaId: 'saga4' });
    }
  });
  it.each(['RESERVED', 'READY', 'IN_PROGRESS', 'COMPLETED'])('does not cancel another active saga in %s', async state => {
    await reserved(); await service.command(message('CancelExecutionReservation'));
    await service.command(message('ReserveExecution', { budget }, 'os1', 'new-active-saga'));
    if (state !== 'RESERVED') await service.command(message('ConfirmExecution', {}, 'os1', 'new-active-saga'));
    if (['IN_PROGRESS', 'COMPLETED'].includes(state)) await service.start('os1');
    if (state === 'COMPLETED') { await service.consume('os1', 'p1', 2); await service.complete('os1'); }
    const before = await service.get('os1'), stock = await store.getStock('f1', 'p1');
    for (const type of ['CancelExecutionReservation', 'ReconcileExecutionReservation']) {
      const reconciliationId = randomUUID();
      await service.command(message(type, { reconciliationId }, 'os1', 'delayed-other-saga'));
      expect(store.outbox.at(-1)?.event.type).toBe('CommandFailed');
      if (type === 'ReconcileExecutionReservation') expect(store.outbox.at(-1)?.event.payload.reconciliationId).toBe(reconciliationId);
      else expect(store.outbox.at(-1)?.event.payload).not.toHaveProperty('reconciliationId');
      expect(await service.get('os1')).toEqual(before);
      expect(await store.getStock('f1', 'p1')).toEqual(stock);
      expect(store.keys.has('CANCELLED#delayed-other-saga')).toBe(false);
    }
  });
  it.each(['missing-tombstone', 'consumed-part'])('rejects ambiguous cancelled aggregate with %s', async scenario => {
    await reserved(); await service.command(message('CancelExecutionReservation'));
    if (scenario === 'missing-tombstone') store.keys.delete('CANCELLED#saga1');
    else store.orders.get('os1')!.parts[0].consumedQuantity = 1;
    const before = await service.get('os1');
    await service.command(message('CancelExecutionReservation', {}, 'os1', 'new-saga'));
    expect(store.outbox.at(-1)?.event).toMatchObject({ type: 'CommandFailed', payload: { reason: 'Saga mismatch' } });
    expect(await service.get('os1')).toEqual(before);
    expect(store.keys.has('CANCELLED#new-saga')).toBe(false);
  });
  it('rechecks cancellation against a concurrent successful reservation', async () => {
    await reserved(); await service.command(message('CancelExecutionReservation'));
    jest.spyOn(store, 'commit').mockImplementationOnce(async () => {
      await service.command(message('ReserveExecution', { budget }, 'os1', 'concurrent-saga'));
      throw new Conflict();
    });
    await service.command(message('CancelExecutionReservation', {}, 'os1', 'failed-attempt'));
    expect(store.outbox.at(-1)?.event).toMatchObject({ type: 'CommandFailed', payload: { reason: 'Saga mismatch' } });
    expect(await service.get('os1')).toMatchObject({ status: 'RESERVED', sagaId: 'concurrent-saga' });
    expect(await store.getStock('f1', 'p1')).toMatchObject({ quantity: 3, reserved: 2 });
    expect(store.keys.has('CANCELLED#failed-attempt')).toBe(false);
  });
  it('reconciles an already recorded cancellation failure without clearing deduplication records', async () => {
    await diagnosed(); await service.stock('f1', 'p1', 0);
    await service.command(message('ReserveExecution', { budget }));
    await service.command(message('CancelExecutionReservation'));
    await service.command(message('ReserveExecution', { budget }, 'os1', 'saga2'));
    // Previous versions persisted this failure and its permanent step key.
    const failedCancellation = message('CancelExecutionReservation', {}, 'os1', 'saga2');
    const failedStep = 'os1#saga2#CancelExecutionReservation';
    await store.commit({ inbox: failedCancellation.messageId, step: failedStep, events: [{
      ...failedCancellation, messageId: randomUUID(), type: 'CommandFailed',
      payload: { commandType: 'CancelExecutionReservation', reason: 'Saga mismatch' },
    }] });
    const reconciliationId = randomUUID();
    const reconciliation = message('ReconcileExecutionReservation', { reconciliationId }, 'os1', 'saga2');
    await service.command(reconciliation);
    expect(store.outbox.at(-1)?.event).toMatchObject({ type: 'ExecutionCancelled', sagaId: 'saga2', payload: { reconciliationId } });
    expect(await service.get('os1')).toMatchObject({ status: 'CANCELLED', sagaId: 'saga2' });
    expect(store.keys.has(`STEP#${failedStep}`)).toBe(true);
    expect(store.keys.has(`STEP#os1#saga2#ReconcileExecutionReservation#${reconciliationId}`)).toBe(true);
    expect(await store.getStock('f1', 'p1')).toMatchObject({ quantity: 0, reserved: 0, used: 0 });
    const count = store.outbox.length;
    await service.command(reconciliation);
    await service.command({ ...reconciliation, messageId: randomUUID() });
    expect(store.outbox).toHaveLength(count);
  });
  it('allows a new reconciliation ID after a failed reconciliation, while deduplicating the old ID', async () => {
    await ready();
    const firstId = randomUUID();
    const first = message('ReconcileExecutionReservation', { reconciliationId: firstId }, 'os1', 'saga2');
    await service.command(first);
    expect(store.outbox.at(-1)?.event).toMatchObject({ type: 'CommandFailed', payload: {
      commandType: 'ReconcileExecutionReservation', reason: 'Saga mismatch', reconciliationId: firstId,
    } });
    await service.command(message('CancelExecutionReservation'));
    const count = store.outbox.length;
    await service.command({ ...first, messageId: randomUUID() });
    expect(store.outbox).toHaveLength(count);
    const secondId = randomUUID();
    await service.command(message('ReconcileExecutionReservation', { reconciliationId: secondId }, 'os1', 'saga2'));
    expect(store.outbox.at(-1)?.event).toMatchObject({ type: 'ExecutionCancelled', sagaId: 'saga2', payload: { reconciliationId: secondId } });
    expect(store.keys.has('CANCELLED#saga2')).toBe(true);
    expect(await store.getStock('f1', 'p1')).toMatchObject({ quantity: 5, reserved: 0 });
  });
  it.each([undefined, null, '', 'not-a-uuid', 42])('rejects invalid reconciliation ID %p before changing state', async reconciliationId => {
    await diagnosed(); const order = await service.get('os1'), count = store.outbox.length;
    await expect(service.command(message('ReconcileExecutionReservation', { reconciliationId }))).rejects.toBeInstanceOf(BadRequestException);
    expect(await service.get('os1')).toEqual(order);
    expect(store.outbox).toHaveLength(count);
    expect(store.keys.size).toBe(0);
  });
  it('rejects cross-branch reconciliation without cancelling the order', async () => {
    await reserved(); await service.command(message('CancelExecutionReservation'));
    const reconciliationId = randomUUID(), order = await service.get('os1');
    await service.command({ ...message('ReconcileExecutionReservation', { reconciliationId }, 'os1', 'saga2'), filialId: 'other-branch' });
    expect(store.outbox.at(-1)?.event).toMatchObject({ type: 'CommandFailed', payload: { reconciliationId, reason: 'Branch mismatch' } });
    expect(await service.get('os1')).toEqual(order);
    expect(store.keys.has('CANCELLED#saga2')).toBe(false);
  });
  it.each(['IN_PROGRESS', 'COMPLETED'])('never compensates physical work in %s', async state => {
    await ready(); await service.start('os1');
    if (state === 'COMPLETED') { await service.consume('os1', 'p1', 2); await service.complete('os1'); }
    await service.command(message('CancelExecutionReservation'));
    expect((await service.get('os1')).status).toBe(state);
    expect(store.outbox.at(-1)?.event.type).toBe('CommandFailed');
    expect(store.keys.has('CANCELLED#saga1')).toBe(false);
  });
  it('keeps order and other stock untouched when one reserved item is unavailable', async () => {
    await diagnosed(); const b = { version: 1, items: [...budget.items, { description: 'Unavailable', quantity: 1, unitPriceCents: 100, pecaId: 'missing' }], totalCents: 300 };
    await service.command(message('ReserveExecution', { budget: b }));
    expect((await service.get('os1')).status).toBe('DIAGNOSIS');
    expect((await store.getStock('f1', 'p1'))?.quantity).toBe(5);
    expect(store.outbox.at(-1)?.event.type).toBe('CommandFailed');
  });
  it('aggregates duplicate piece lines and propagates trace context', async () => {
    await diagnosed(); await service.command({ ...message('ReserveExecution', { budget: { ...budget, items: [...budget.items, ...budget.items], totalCents: 400 } }), traceparent: '00-01234567890123456789012345678901-0123456789012345-01' });
    expect((await service.get('os1')).parts).toEqual([{ pecaId: 'p1', description: 'Filtro', quantity: 4, consumedQuantity: 0 }]);
    expect(store.outbox.at(-1)?.event).toMatchObject({ correlationId: 'corr1', sagaId: 'saga1', traceparent: expect.any(String) });
  });
  it.each([
    {}, { budget: { ...budget, version: 0 } }, { budget: { ...budget, totalCents: 201 } },
    { budget: { ...budget, items: [{ ...budget.items[0], quantity: -1 }] } },
    { budget: { ...budget, items: [{ ...budget.items[0], unitPriceCents: 0.5 }] } },
    { budget: { ...budget, items: [{ ...budget.items[0], description: '' }] } },
    { budget: { ...budget, items: [{ ...budget.items[0], pecaId: '' }] } },
    { budget: { ...budget, items: Array(51).fill(budget.items[0]) } },
  ])('rejects malformed budget %# without reserving stock', async payload => {
    await diagnosed(); await service.command(message('ReserveExecution', payload));
    expect((await service.get('os1')).status).toBe('DIAGNOSIS'); expect(store.outbox.at(-1)?.event.type).toBe('CommandFailed');
  });
  it('supports labor-only execution without stock changes', async () => {
    await diagnosed(); await service.command(message('ReserveExecution', { budget: { version: 1, items: [{ description: 'Labor', quantity: 1, unitPriceCents: 100 }], totalCents: 100 } }));
    await service.command(message('ConfirmExecution')); await service.start('os1');
    expect((await service.complete('os1')).status).toBe('COMPLETED');
  });
  it('enforces valid states, assignment, and reserved quantities', async () => {
    await service.create({ osId: 'os1', filialId: 'f1', clienteId: 'c1' });
    await expect(service.diagnosis('os1', 'x')).rejects.toBeInstanceOf(ConflictException);
    await service.command(message('ReserveExecution', { budget })); expect(store.outbox.at(-1)?.event.type).toBe('CommandFailed');
    await expect(service.start('os1')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.complete('os1')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.consume('os1', 'p1', 1)).rejects.toBeInstanceOf(ConflictException);
    await service.assign('os1', 'm1'); await service.diagnosis('os1', 'Repair'); await service.stock('f1', 'p1', 5);
    await service.command(message('ReserveExecution', { budget }, 'os1', 'saga2'));
    await expect(service.assign('os1', 'm2')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.diagnosis('os1', 'change')).rejects.toBeInstanceOf(ConflictException);
    await service.command(message('ConfirmExecution', {}, 'os1', 'saga2')); await service.start('os1');
    await expect(service.consume('os1', 'missing', 1)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.consume('os1', 'p1', 3)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.consume('os1', 'p1', 0)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.complete('os1')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.stock('f1', 'p1', -1)).rejects.toBeInstanceOf(BadRequestException);
  });
  it.each(['ReserveExecution', 'ConfirmExecution', 'Unknown'])('fails %s without order', async type => {
    await service.command(message(type, { budget })); expect(store.outbox[0].event.type).toBe('CommandFailed');
  });
  it('fails branch/saga mismatches and unknown commands without changing aggregates', async () => {
    await reserved();
    await service.command({ ...message('ConfirmExecution'), filialId: 'other' });
    await service.command(message('ConfirmExecution', {}, 'os1', 'otherSaga'));
    await service.command(message('CancelExecutionReservation', {}, 'os1', 'otherSaga'));
    await service.command({ ...message('CancelExecutionReservation'), filialId: 'other' });
    await service.command(message('Unknown'));
    expect((await service.get('os1')).status).toBe('RESERVED');
    expect(store.outbox.filter(x => x.event.type === 'CommandFailed')).toHaveLength(5);
  });
  it('injects confirmation failure only when explicitly enabled and still compensates', async () => {
    await reserved(); process.env.ENABLE_DEMO_FAILURES = 'true';
    await service.command(message('ConfirmExecution', { failStage: 'ConfirmExecution' }));
    expect(store.outbox.at(-1)?.event.payload.reason).toContain('Injected');
    await service.command(message('CancelExecutionReservation'));
    expect((await store.getStock('f1', 'p1'))?.reserved).toBe(0);
  });
  it('ignores failStage when demo injection is disabled', async () => {
    await reserved(); await service.command(message('ConfirmExecution', { failStage: 'ConfirmExecution' }));
    expect((await service.get('os1')).status).toBe('READY');
  });
  it('retries optimistic conflicts and maps insufficient inventory', async () => {
    await diagnosed(); const commit = jest.spyOn(store, 'commit');
    commit.mockRejectedValueOnce(new Conflict()); await service.assign('os1', 'm2');
    commit.mockRejectedValueOnce(new InsufficientStock('lost reservation'));
    await expect(service.assign('os1', 'm3')).rejects.toThrow('lost reservation');
    commit.mockRejectedValueOnce(new Error('offline')); await expect(service.assign('os1', 'm3')).rejects.toThrow('offline');
    commit.mockRejectedValue(new Conflict()); await expect(service.assign('os1', 'm3')).rejects.toBeInstanceOf(ConflictException);
  });
  it('rechecks mechanic ownership on every optimistic retry after concurrent reassignment',async()=>{
    await diagnosed();
    jest.spyOn(store,'commit').mockImplementationOnce(async()=>{
      const stored=store.orders.get('os1')!;stored.mecanicoId='m2';stored.revision++;
      throw new Conflict();
    });
    await expect(service.diagnosis('os1','Unauthorized after reassignment',{sub:'m1',role:'MECANICO'})).rejects.toThrow('Order access denied');
    expect((await service.get('os1')).diagnosis).toBe('Trocar filtro');
  });
  it('retries command transaction conflicts and propagates exhausted/transient failures for redelivery', async () => {
    await diagnosed(); const commit = jest.spyOn(store, 'commit').mockRejectedValueOnce(new Conflict());
    await service.command(message('ReserveExecution', { budget }));
    commit.mockRejectedValueOnce(new Error('offline')); await expect(service.command(message('ConfirmExecution'))).rejects.toThrow('offline');
    commit.mockRejectedValue(new Conflict()); await expect(service.command(message('ConfirmExecution'))).rejects.toBeInstanceOf(Conflict);
  });
  it('retries failure recording conflict but preserves non-domain failure for retry', async () => {
    jest.spyOn(store, 'commit').mockRejectedValueOnce(new Conflict());
    await service.command(message('Unknown'));
    expect(store.outbox[0].event.type).toBe('CommandFailed');
    jest.spyOn(store, 'commit').mockRejectedValueOnce(new Error('cannot record'));
    await expect(service.command(message('Unknown', {}, 'other'))).rejects.toThrow('cannot record');
  });
});
