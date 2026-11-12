import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { isUUID } from 'class-validator';
import { Commit, Conflict, ConsumptionReceipt, Envelope, InsufficientStock, Order, Part, StockChange, StockShortage, Store } from './model';
import { Actor, ownership } from './auth';
import { activeTraceparent } from './tracing';

@Injectable()
export class ProductionService {
  constructor(private readonly store: Store) {}
  async get(osId: string): Promise<Order> {
    const order = await this.store.getOrder(osId);
    if (!order) throw new NotFoundException('Production order not found');
    return order;
  }
  list(filialId?: string): Promise<Order[]> { return this.store.listOrders(filialId); }
  async create(input: { osId: string; filialId: string; clienteId: string; mecanicoId?: string }): Promise<Order> {
    const existing = await this.store.getOrder(input.osId);
    if (existing) {
      if (existing.filialId !== input.filialId || existing.clienteId !== input.clienteId) throw new ConflictException('Order ownership mismatch');
      return existing;
    }
    const order: Order = { ...input, status: 'DIAGNOSIS', parts: [], revision: 0 };
    try { await this.store.commit({ order, events: [] }); }
    catch (error) { if (error instanceof Conflict) return this.create(input); throw error; }
    return order;
  }
  private event(order: Pick<Order, 'osId' | 'filialId' | 'sagaId'>, type: string, payload: object, origin?: Envelope): Envelope {
    const traceparent=activeTraceparent(origin?.traceparent);
    return {
      messageId: randomUUID(), type, version: 1, sagaId: origin?.sagaId || order.sagaId || order.osId,
      osId: order.osId, filialId: order.filialId, correlationId: origin?.correlationId || order.osId,
      occurredAt: new Date().toISOString(), ...(traceparent ? { traceparent } : {}), payload,
    };
  }
  private async update(osId: string, fn: (order: Order) => { type: string; payload: object; stocks?: StockChange[] }, actor?: Actor, consumption?: ConsumptionReceipt): Promise<Order> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const order = structuredClone(await this.get(osId)), expectedRevision = order.revision;
      if (actor) ownership(actor,order,true);
      if (consumption) {
        const fingerprint = await this.store.getConsumptionReceipt(osId, consumption.operationId);
        if (fingerprint !== undefined) {
          // A concurrent request may have committed after the first aggregate read.
          // Re-read and authorize the current aggregate before returning a receipt.
          const current = await this.get(osId);
          if (actor) ownership(actor, current, true);
          if (fingerprint !== consumption.fingerprint) throw new ConflictException('operationId already used for a different consumption');
          return current;
        }
      }
      const result = fn(order);
      order.revision++;
      try {
        await this.store.commit({ order, expectedRevision, consumption, stocks: result.stocks, events: [this.event(order, result.type, result.payload)] });
        return order;
      } catch (error) {
        if (error instanceof InsufficientStock) {
          // Dynamo can report the exhausted reservation as well as the duplicate
          // receipt/revision condition when two identical requests race.
          if (consumption && await this.store.getConsumptionReceipt(osId, consumption.operationId) !== undefined) continue;
          // Independent consumers can exhaust the same reservation concurrently.
          // Revalidate against the winning revision to explain the remaining
          // quantity; an unchanged revision still means a stock inconsistency.
          if (consumption && (await this.get(osId)).revision !== expectedRevision) continue;
          throw new ConflictException(error.message);
        }
        if (!(error instanceof Conflict)) throw error;
      }
    }
    throw new ConflictException('Concurrent update; retry request');
  }
  assign(osId: string, mecanicoId: string): Promise<Order> {
    return this.update(osId, order => {
      if (order.status !== 'DIAGNOSIS') throw new ConflictException('Assignment only during diagnosis');
      order.mecanicoId = mecanicoId;
      return { type: 'MechanicAssigned', payload: { mecanicoId } };
    });
  }
  diagnosis(osId: string, descricao: string, actor?: Actor): Promise<Order> {
    return this.update(osId, order => {
      if (order.status !== 'DIAGNOSIS') throw new ConflictException('Diagnosis is locked');
      if (!order.mecanicoId) throw new ConflictException('Assign a mechanic first');
      order.diagnosis = descricao;
      return { type: 'DiagnosisRecorded', payload: { descricao } };
    },actor);
  }
  start(osId: string, actor?: Actor): Promise<Order> {
    return this.update(osId, order => {
      if (order.status !== 'READY') throw new ConflictException('Execution is not confirmed');
      order.status = 'IN_PROGRESS';
      return { type: 'ExecutionStarted', payload: {} };
    },actor);
  }
  async consume(osId: string, pecaId: string, quantidade: number, actor?: Actor, operationId?: string): Promise<Order> {
    if (operationId !== undefined && !isUUID(operationId)) throw new BadRequestException('Valid operationId required');
    const consumption = operationId === undefined ? undefined : {
      osId, operationId: operationId.toLowerCase(),
      fingerprint: createHash('sha256').update(JSON.stringify([pecaId, quantidade])).digest('hex'),
    };
    return this.update(osId, order => {
      if (order.status !== 'IN_PROGRESS') throw new ConflictException('Execution must be in progress');
      const part = order.parts.find(item => item.pecaId === pecaId);
      const details = {
        statusCode: 400, definitive: true, pecaId, filialId: order.filialId,
        quantidadeSolicitada: quantidade, quantidadeReservada: part?.quantity ?? 0,
        quantidadeConsumida: part?.consumedQuantity ?? 0,
        quantidadeRestante: part ? part.quantity - part.consumedQuantity : 0,
      };
      if (!Number.isSafeInteger(quantidade) || quantidade < 1) throw new BadRequestException({ ...details, code: 'INVALID_CONSUMPTION_QUANTITY', message: 'Informe uma quantidade inteira maior que zero. Nenhum consumo foi registrado.' });
      if (!part) throw new BadRequestException({ ...details, code: 'PART_NOT_RESERVED', message: 'Esta peça não está reservada para a ordem. Nenhum consumo foi registrado.' });
      if (quantidade > details.quantidadeRestante) throw new BadRequestException({ ...details, code: 'QUANTITY_EXCEEDS_RESERVATION', message: `A quantidade excede a reserva desta ordem. Restam ${details.quantidadeRestante} unidade(s). Nenhum consumo foi registrado.` });
      part.consumedQuantity += quantidade;
      return { type: 'PartsConsumed', payload: { pecaId, quantidade }, stocks: [{ pecaId, filialId: order.filialId, quantity: quantidade, action: 'consume' }] };
    },actor,consumption);
  }
  complete(osId: string, actor?: Actor): Promise<Order> {
    return this.update(osId, order => {
      if (order.status !== 'IN_PROGRESS') throw new ConflictException('Execution must be in progress');
      if (order.parts.some(part => part.consumedQuantity !== part.quantity)) throw new ConflictException('Consume all reserved parts before completion');
      order.status = 'COMPLETED';
      return { type: 'ProductionCompleted', payload: {} };
    },actor);
  }
  async stock(filialId: string, pecaId: string, quantity: number, description?: string) {
    if (!Number.isInteger(quantity) || quantity < 0) throw new BadRequestException('Invalid stock quantity');
    return this.store.putStock({ filialId, pecaId, quantity, description });
  }
  private parts(payload: Envelope['payload']): Part[] {
    const budget = payload.budget;
    if (!budget || !Array.isArray(budget.items) || budget.items.length > 50 || !Number.isSafeInteger(budget.totalCents) || budget.totalCents < 0 || !Number.isInteger(budget.version) || budget.version < 1) throw new BadRequestException('Invalid budget');
    let total = 0;
    const parts = new Map<string, Part>();
    for (const item of budget.items) {
      if (typeof item.description !== 'string' || !item.description.trim() || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || !Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0 || (item.pecaId !== undefined && (typeof item.pecaId !== 'string' || !item.pecaId))) throw new BadRequestException('Invalid budget item');
      total += item.quantity * item.unitPriceCents;
      if (item.pecaId) {
        const part = parts.get(item.pecaId) || { pecaId: item.pecaId, description: item.description, quantity: 0, consumedQuantity: 0 };
        part.quantity += item.quantity; parts.set(item.pecaId, part);
      }
    }
    if (!Number.isSafeInteger(total) || total !== budget.totalCents) throw new BadRequestException('Budget total mismatch');
    return [...parts.values()];
  }
  private async reservationShortages(filialId: string, parts: Part[]): Promise<StockShortage[]> {
    const inspected = await Promise.all(parts.map(async part => {
      const stock = await this.store.getStock(filialId, part.pecaId);
      // Keep identity snapshots with the reservation; labels never become keys.
      if (stock?.codigo) part.codigo = stock.codigo;
      if (stock?.nome) part.nome = stock.nome;
      const motivo = !stock ? 'PECA_NAO_ENCONTRADA_NA_FILIAL'
        : stock.ativo === false ? 'PECA_INATIVA'
        : stock.quantity < part.quantity ? 'ESTOQUE_INSUFICIENTE' : undefined;
      if (!motivo) return undefined;
      return {
        pecaId: part.pecaId, nome: stock?.nome || stock?.description || part.description,
        ...(stock?.codigo ? { codigo: stock.codigo } : {}), filialId,
        quantidadeNecessaria: part.quantity, quantidadeDisponivel: stock?.quantity ?? 0,
        quantidadeFaltante: motivo === 'ESTOQUE_INSUFICIENTE' ? part.quantity - stock!.quantity : part.quantity,
        motivo,
      } satisfies StockShortage;
    }));
    return inspected.filter((item): item is StockShortage => item !== undefined);
  }
  async command(message: Envelope): Promise<void> {
    const reconciliation = message.type === 'ReconcileExecutionReservation';
    const reconciliationId = message.payload?.reconciliationId;
    if (reconciliation && !isUUID(reconciliationId)) throw new BadRequestException('Valid reconciliationId required');
    const reconciliationPayload = reconciliation ? { reconciliationId } : {};
    const step = `${message.osId}#${message.sagaId}#${message.type}${reconciliation ? `#${reconciliationId}` : ''}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await this.store.exists(`INBOX#${message.messageId}`) || await this.store.exists(`STEP#${step}`)) return;
      let change: Commit = { inbox: message.messageId, step, events: [] };
      try {
        const current = await this.store.getOrder(message.osId);
        const order = current ? structuredClone(current) : undefined;
        const cancelled = await this.store.exists(`CANCELLED#${message.sagaId}`);
        if (message.type === 'CancelExecutionReservation' || reconciliation) {
          if (order && order.filialId !== message.filialId) throw new BadRequestException('Branch mismatch');
          if (order && ['IN_PROGRESS', 'COMPLETED'].includes(order.status)) throw new BadRequestException('Physical work cannot be compensated');
          if (order?.sagaId && order.sagaId !== message.sagaId) {
            // A failed retry never owned a reservation. A previously compensated
            // aggregate can acknowledge its cancellation without releasing stock twice.
            const previousAttemptCancelled = order.status === 'CANCELLED'
              && order.parts.every(part => part.consumedQuantity === 0)
              && await this.store.exists(`CANCELLED#${order.sagaId}`);
            if (!previousAttemptCancelled) throw new BadRequestException('Saga mismatch');
          }
          change.cancelSaga = message.sagaId;
          if (order) {
            if (['RESERVED', 'READY'].includes(order.status)) change.stocks = order.parts.map(part => ({ pecaId: part.pecaId, filialId: order.filialId, quantity: part.quantity - part.consumedQuantity, action: 'release' }));
            order.status = 'CANCELLED'; order.sagaId = message.sagaId;
            change.order = { ...order, revision: order.revision + 1 }; change.expectedRevision = order.revision;
          }
          change.events.push(this.event(message, 'ExecutionCancelled', reconciliationPayload, message));
        } else {
          if (cancelled) throw new BadRequestException('Saga already cancelled');
          if (!order) throw new BadRequestException('Production order not found');
          if (order.filialId !== message.filialId) throw new BadRequestException('Branch mismatch');
          if (process.env.ENABLE_DEMO_FAILURES === 'true' && message.payload.failStage === message.type) throw new BadRequestException('Injected demonstration failure');
          if (message.type === 'ReserveExecution') {
            const reservable = order.status === 'DIAGNOSIS' || (order.status === 'CANCELLED' && order.sagaId !== message.sagaId);
            if (!reservable || !order.mecanicoId || !order.diagnosis) throw new BadRequestException('Diagnosed order with mechanic required');
            order.parts = this.parts(message.payload);
            const shortages = await this.reservationShortages(order.filialId, order.parts);
            if (shortages.length) throw new InsufficientStock('Insufficient stock or reservation', shortages);
            order.status = 'RESERVED'; order.sagaId = message.sagaId;
            change.stocks = order.parts.map(part => ({ pecaId: part.pecaId, filialId: order.filialId, quantity: part.quantity, action: 'reserve' }));
            change.events.push(this.event(order, 'ExecutionReserved', {}, message));
          } else if (message.type === 'ConfirmExecution') {
            if (order.status !== 'RESERVED' || order.sagaId !== message.sagaId) throw new BadRequestException('Reservation not found');
            order.status = 'READY';
            change.events.push(this.event(order, 'ExecutionReady', {}, message));
          } else throw new BadRequestException('Unknown command');
          change.activeSaga = message.sagaId;
          change.order = { ...order, revision: order.revision + 1 }; change.expectedRevision = order.revision;
        }
        await this.store.commit(change);
        return;
      } catch (error) {
        if (error instanceof Conflict) continue;
        if (!(error instanceof BadRequestException || error instanceof InsufficientStock)) throw error;
        // A transaction can reject stock changed after the preflight. Read fresh
        // balances for the failure explanation; the transaction remains authority.
        const shortageDetails = error instanceof InsufficientStock && message.type === 'ReserveExecution'
          ? { code: 'INSUFFICIENT_STOCK', faltasEstoque: error.shortages ?? await this.reservationShortages(message.filialId, change.order?.parts || this.parts(message.payload)) }
          : {};
        change = { inbox: message.messageId, step, events: [this.event(message, 'CommandFailed', { commandType: message.type, reason: error.message, ...shortageDetails, ...reconciliationPayload }, message)] };
        try { await this.store.commit(change); return; }
        catch (failure) { if (!(failure instanceof Conflict)) throw failure; }
      }
    }
    throw new Conflict('Command contention; retry delivery');
  }
}
