import { randomUUID } from 'crypto';
import { Envelope } from '../src/model';
import { ProductionService } from '../src/production.service';
import { MemoryStore } from './memory.store';

describe('Preparation explains authoritative stock failures', () => {
  let store: MemoryStore; let service: ProductionService;
  const budget = { version: 1, totalCents: 300, items: [{ pecaId: 'p1', description: 'Filtro solicitado', quantity: 3, unitPriceCents: 100 }] };
  const message = (type: string, sagaId = randomUUID(), payload = {}): Envelope => ({ messageId: randomUUID(), type, version: 1, osId: 'os1', filialId: 'sp', sagaId, correlationId: 'c', occurredAt: new Date().toISOString(), payload });
  beforeEach(async () => {
    store = new MemoryStore(); service = new ProductionService(store);
    await service.create({ osId: 'os1', filialId: 'sp', clienteId: 'c1' }); await service.assign('os1', 'm1'); await service.diagnosis('os1', 'Trocar filtro');
    await store.createCatalog({ pecaId: 'p1', filialId: 'sp', codigo: 'OLEO-50', nome: 'Filtro de óleo', ativo: true, quantity: 1, reserved: 0, used: 0 });
    await store.createCatalog({ pecaId: 'p1', filialId: 'rj', codigo: 'OLEO-50', nome: 'Filtro de óleo RJ', ativo: true, quantity: 10, reserved: 0, used: 0 });
  });
  it('reports exact deficit on three retries and ignores replenishment in the other branch', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const saga = randomUUID(); await service.command(message('ReserveExecution', saga, { budget }));
      expect(store.outbox.at(-1)?.event.payload).toMatchObject({ code: 'INSUFFICIENT_STOCK', faltasEstoque: [{ pecaId: 'p1', nome: 'Filtro de óleo', codigo: 'OLEO-50', filialId: 'sp', quantidadeNecessaria: 3, quantidadeDisponivel: 1, quantidadeFaltante: 2, motivo: 'ESTOQUE_INSUFICIENTE' }] });
      await service.command(message('CancelExecutionReservation', saga));
      await store.addStock('rj', 'p1', 2);
      expect(await store.getStock('sp', 'p1')).toMatchObject({ quantity: 1, reserved: 0, used: 0 });
    }
    await store.addStock('sp', 'p1', 2); const saga = randomUUID(); await service.command(message('ReserveExecution', saga, { budget }));
    expect(await service.get('os1')).toMatchObject({ status: 'RESERVED', parts: [{ codigo: 'OLEO-50', nome: 'Filtro de óleo', quantity: 3, consumedQuantity: 0 }] });
    expect(await store.getStock('sp', 'p1')).toMatchObject({ quantity: 0, reserved: 3, used: 0 });
  });
  it.each(['inactive', 'missing'])('identifies %s separately from an active zero balance and never reserves it', async state => {
    if (state === 'inactive') { const stock = store.stocks.get('sp#p1')!; stock.ativo = false; stock.quantity = 10; }
    else store.stocks.delete('sp#p1');
    await service.command(message('ReserveExecution', undefined, { budget }));
    expect(store.outbox.at(-1)?.event.payload.faltasEstoque[0]).toMatchObject({ filialId: 'sp', quantidadeFaltante: 3, motivo: state === 'inactive' ? 'PECA_INATIVA' : 'PECA_NAO_ENCONTRADA_NA_FILIAL' });
    expect((await service.get('os1')).status).toBe('DIAGNOSIS');
    expect((await store.getStock('rj', 'p1'))?.reserved).toBe(0);
  });
  it('preserves transaction authority and reads fresh deficits after a concurrent stock change', async () => {
    await store.addStock('sp', 'p1', 2);
    const commit = store.commit.bind(store);
    jest.spyOn(store, 'commit').mockImplementationOnce(async change => {
      store.stocks.get('sp#p1')!.quantity = 0;
      await commit(change);
    });
    await service.command(message('ReserveExecution', undefined, { budget }));
    expect(store.outbox.at(-1)?.event.payload).toMatchObject({ code: 'INSUFFICIENT_STOCK', faltasEstoque: [{ quantidadeDisponivel: 0, quantidadeFaltante: 3 }] });
    expect((await service.get('os1')).status).toBe('DIAGNOSIS');
    expect((await store.getStock('sp', 'p1'))?.reserved).toBe(0);
  });
  it('does not commit a misleading business failure when inventory lookup is unavailable', async () => {
    jest.spyOn(store, 'getStock').mockRejectedValueOnce(new Error('store unavailable'));
    await expect(service.command(message('ReserveExecution', undefined, { budget }))).rejects.toThrow('store unavailable');
    expect(store.outbox.filter(x => x.event.type === 'CommandFailed')).toHaveLength(0);
  });
});
