export type Status = 'DIAGNOSIS' | 'RESERVED' | 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export interface Part { pecaId: string; description: string; quantity: number; consumedQuantity: number }
export interface Order {
  osId: string; filialId: string; clienteId: string; mecanicoId?: string;
  status: Status; diagnosis?: string; parts: Part[]; sagaId?: string; revision: number;
}
export interface Envelope {
  messageId: string; type: string; version: 1; sagaId: string; osId: string;
  filialId: string; correlationId: string; occurredAt: string; traceparent?: string;
  payload: Record<string, any>;
}
export interface Stock {
  pecaId: string; filialId: string; quantity: number; reserved: number; used: number; description?: string;
  codigo?: string; nome?: string; descricao?: string | null; precoVenda?: number; ativo?: boolean; quantidadeMinima?: number;
}
export interface StockChange { pecaId: string; filialId: string; action: 'reserve' | 'release' | 'consume'; quantity: number }
export interface Commit {
  order?: Order; expectedRevision?: number; inbox?: string; step?: string;
  cancelSaga?: string; activeSaga?: string; stocks?: StockChange[]; events: Envelope[];
}
export interface OutboxItem { pk: string; event: Envelope }
export abstract class Store {
  abstract getOrder(osId: string): Promise<Order | undefined>;
  abstract listOrders(filialId?: string): Promise<Order[]>;
  abstract getStock(filialId: string, pecaId: string): Promise<Stock | undefined>;
  abstract putStock(stock: Omit<Stock, 'reserved' | 'used'>): Promise<Stock>;
  abstract listStock(filialId?: string): Promise<Stock[]>;
  abstract createCatalog(stock: Stock): Promise<void>;
  abstract updateCatalog(filialId: string, pecaId: string, patch: Partial<Stock>): Promise<Stock>;
  abstract addStock(filialId: string, pecaId: string, quantity: number): Promise<Stock>;
  abstract exists(pk: string): Promise<boolean>;
  abstract commit(change: Commit): Promise<void>;
  abstract pending(): Promise<OutboxItem[]>;
  abstract claim(pk: string, owner: string): Promise<boolean>;
  abstract sent(pk: string, owner: string): Promise<void>;
}
export class Conflict extends Error {}
export class InsufficientStock extends Error {}
