import { Commit, Conflict, InsufficientStock, Order, OutboxItem, Stock, Store } from '../src/model';
export class MemoryStore extends Store {
  orders = new Map<string, Order>(); stocks = new Map<string, Stock>(); keys = new Set<string>(); outbox: OutboxItem[] = [];
  consumptions = new Map<string, string>();
  async getOrder(id: string) { return structuredClone(this.orders.get(id)); }
  async listOrders(filial?: string) { return structuredClone([...this.orders.values()].filter(o => !filial || o.filialId === filial)); }
  async getStock(filial: string, id: string) { return structuredClone(this.stocks.get(`${filial}#${id}`)); }
  async putStock(stock: Omit<Stock, 'reserved' | 'used'>) {
    const existing = await this.getStock(stock.filialId, stock.pecaId);
    const value = { reserved: 0, used: 0, ...existing, ...stock };
    this.stocks.set(`${stock.filialId}#${stock.pecaId}`, value); return value;
  }
  async listStock(filialId?: string) { return structuredClone([...this.stocks.values()].filter(stock => !filialId || stock.filialId === filialId)); }
  async createCatalog(stock: Stock) {
    if ([...this.stocks.values()].some(s => s.filialId === stock.filialId && s.codigo === stock.codigo)) throw new Conflict('Piece code already registered in branch');
    this.stocks.set(`${stock.filialId}#${stock.pecaId}`, structuredClone(stock));
  }
  async updateCatalog(filialId: string, pecaId: string, patch: Partial<Stock>) { const stock = this.stocks.get(`${filialId}#${pecaId}`)!; Object.assign(stock, patch); return structuredClone(stock); }
  async addStock(filialId: string, pecaId: string, quantity: number) { const stock = this.stocks.get(`${filialId}#${pecaId}`)!; stock.quantity += quantity; return structuredClone(stock); }
  async exists(key: string) { return this.keys.has(key); }
  async getConsumptionReceipt(osId: string, operationId: string) { return this.consumptions.get(`${osId}#${operationId}`); }
  async commit(change: Commit) {
    if (change.consumption && this.consumptions.has(`${change.consumption.osId}#${change.consumption.operationId}`)) throw new Conflict();
    if ((change.inbox && this.keys.has(`INBOX#${change.inbox}`)) || (change.step && this.keys.has(`STEP#${change.step}`)) || (change.activeSaga && this.keys.has(`CANCELLED#${change.activeSaga}`))) throw new Conflict();
    if (change.order) {
      const existing = this.orders.get(change.order.osId);
      if (existing?.revision !== change.expectedRevision) throw new Conflict();
    }
    const stocks = structuredClone(this.stocks);
    for (const action of change.stocks || []) {
      const stock = stocks.get(`${action.filialId}#${action.pecaId}`);
      if (!stock || (action.action === 'reserve' && stock.ativo === false) || (action.action === 'reserve' ? stock.quantity : stock.reserved) < action.quantity) throw new InsufficientStock('Insufficient stock or reservation');
      if (action.action === 'reserve') { stock.quantity -= action.quantity; stock.reserved += action.quantity; }
      if (action.action === 'release') { stock.quantity += action.quantity; stock.reserved -= action.quantity; }
      if (action.action === 'consume') { stock.reserved -= action.quantity; stock.used += action.quantity; }
    }
    this.stocks = stocks;
    if (change.order) this.orders.set(change.order.osId, structuredClone(change.order));
    if (change.inbox) this.keys.add(`INBOX#${change.inbox}`);
    if (change.step) this.keys.add(`STEP#${change.step}`);
    if (change.consumption) this.consumptions.set(`${change.consumption.osId}#${change.consumption.operationId}`, change.consumption.fingerprint);
    if (change.cancelSaga) this.keys.add(`CANCELLED#${change.cancelSaga}`);
    this.outbox.push(...change.events.map(event => ({ pk: `OUTBOX#${event.messageId}`, event })));
  }
  async pending() { return this.outbox; }
  async claim() { return true; }
  async sent(pk: string) { this.outbox = this.outbox.filter(item => item.pk !== pk); }
}
