import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Commit, Conflict, Envelope, InsufficientStock, Order, Part, StockChange, Store } from './model';
import { Actor, ownership } from './auth';

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
    return {
      messageId: randomUUID(), type, version: 1, sagaId: origin?.sagaId || order.sagaId || order.osId,
      osId: order.osId, filialId: order.filialId, correlationId: origin?.correlationId || order.osId,
      occurredAt: new Date().toISOString(), ...(origin?.traceparent ? { traceparent: origin.traceparent } : {}), payload,
    };
  }
  private async update(osId: string, fn: (order: Order) => { type: string; payload: object; stocks?: StockChange[] }, actor?: Actor): Promise<Order> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const order = structuredClone(await this.get(osId)), expectedRevision = order.revision;
      if (actor) ownership(actor,order,true);
      const result = fn(order);
      order.revision++;
      try {
        await this.store.commit({ order, expectedRevision, stocks: result.stocks, events: [this.event(order, result.type, result.payload)] });
        return order;
      } catch (error) {
        if (error instanceof InsufficientStock) throw new ConflictException(error.message);
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
  consume(osId: string, pecaId: string, quantidade: number, actor?: Actor): Promise<Order> {
    return this.update(osId, order => {
      if (order.status !== 'IN_PROGRESS') throw new ConflictException('Execution must be in progress');
      const part = order.parts.find(item => item.pecaId === pecaId);
      if (!Number.isInteger(quantidade) || quantidade < 1 || !part || part.consumedQuantity + quantidade > part.quantity) throw new BadRequestException('Quantity exceeds this order reservation');
      part.consumedQuantity += quantidade;
      return { type: 'PartsConsumed', payload: { pecaId, quantidade }, stocks: [{ pecaId, filialId: order.filialId, quantity: quantidade, action: 'consume' }] };
    },actor);
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
  async command(message: Envelope): Promise<void> {
    const step = `${message.osId}#${message.sagaId}#${message.type}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await this.store.exists(`INBOX#${message.messageId}`) || await this.store.exists(`STEP#${step}`)) return;
      let change: Commit = { inbox: message.messageId, step, events: [] };
      try {
        const current = await this.store.getOrder(message.osId);
        const order = current ? structuredClone(current) : undefined;
        const cancelled = await this.store.exists(`CANCELLED#${message.sagaId}`);
        if (message.type === 'CancelExecutionReservation') {
          if (order && order.filialId !== message.filialId) throw new BadRequestException('Branch mismatch');
          if (order && ['IN_PROGRESS', 'COMPLETED'].includes(order.status)) throw new BadRequestException('Physical work cannot be compensated');
          if (order?.sagaId && order.sagaId !== message.sagaId) throw new BadRequestException('Saga mismatch');
          change.cancelSaga = message.sagaId;
          if (order) {
            if (['RESERVED', 'READY'].includes(order.status)) change.stocks = order.parts.map(part => ({ pecaId: part.pecaId, filialId: order.filialId, quantity: part.quantity - part.consumedQuantity, action: 'release' }));
            order.status = 'CANCELLED'; order.sagaId = message.sagaId;
            change.order = { ...order, revision: order.revision + 1 }; change.expectedRevision = order.revision;
          }
          change.events.push(this.event(message, 'ExecutionCancelled', {}, message));
        } else {
          if (cancelled) throw new BadRequestException('Saga already cancelled');
          if (!order) throw new BadRequestException('Production order not found');
          if (order.filialId !== message.filialId) throw new BadRequestException('Branch mismatch');
          if (process.env.ENABLE_DEMO_FAILURES === 'true' && message.payload.failStage === message.type) throw new BadRequestException('Injected demonstration failure');
          if (message.type === 'ReserveExecution') {
            const reservable = order.status === 'DIAGNOSIS' || (order.status === 'CANCELLED' && order.sagaId !== message.sagaId);
            if (!reservable || !order.mecanicoId || !order.diagnosis) throw new BadRequestException('Diagnosed order with mechanic required');
            order.parts = this.parts(message.payload); order.status = 'RESERVED'; order.sagaId = message.sagaId;
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
        change = { inbox: message.messageId, step, events: [this.event(message, 'CommandFailed', { commandType: message.type, reason: error.message }, message)] };
        try { await this.store.commit(change); return; }
        catch (failure) { if (!(failure instanceof Conflict)) throw failure; }
      }
    }
    throw new Conflict('Command contention; retry delivery');
  }
}
