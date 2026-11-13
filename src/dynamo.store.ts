import { Injectable } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Commit, Conflict, InsufficientStock, Order, OutboxItem, Stock, Store } from './model';

@Injectable()
export class DynamoStore extends Store {
  private readonly table = process.env.DYNAMODB_TABLE_NAME || 'oficina-production';
  private readonly db = DynamoDBDocumentClient.from(new DynamoDBClient({
    region: process.env.AWS_REGION || 'us-east-1', endpoint: process.env.AWS_ENDPOINT_URL,
  }), { marshallOptions: { removeUndefinedValues: true } });

  private async get(pk: string): Promise<any> {
    return (await this.db.send(new GetCommand({ TableName: this.table, Key: { pk }, ConsistentRead: true }))).Item;
  }
  async getOrder(osId: string): Promise<Order | undefined> { return (await this.get(`ORDER#${osId}`))?.value; }
  async exists(pk: string): Promise<boolean> { return !!(await this.get(pk)); }
  async getConsumptionReceipt(osId: string, operationId: string): Promise<string | undefined> {
    return (await this.get(`CONSUMPTION#${osId}#${operationId}`))?.fingerprint;
  }
  async listOrders(filialId?: string): Promise<Order[]> {
    const result: Order[] = [];
    let cursor: Record<string, any> | undefined;
    do {
      const page = await this.db.send(filialId ? new QueryCommand({
        TableName: this.table, IndexName: 'pending-index', KeyConditionExpression: 'gsi1pk = :scope',
        ExpressionAttributeValues: { ':scope': `ORDERS#${filialId}` }, ExclusiveStartKey: cursor,
      }) : new ScanCommand({ TableName: this.table, FilterExpression: 'begins_with(pk, :p)',
        ExpressionAttributeValues: { ':p': 'ORDER#' }, ExclusiveStartKey: cursor }));
      result.push(...(page.Items || []).map(item => item.value as Order));
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return result;
  }
  async getStock(filialId: string, pecaId: string): Promise<Stock | undefined> { return (await this.get(`STOCK#${filialId}#${pecaId}`))?.value; }
  async listStock(filialId?: string): Promise<Stock[]> {
    const values: Stock[] = [];
    let cursor: Record<string, any> | undefined;
    do {
      const page = await this.db.send(new ScanCommand({ TableName: this.table, FilterExpression: 'begins_with(pk, :p)',
        ExpressionAttributeValues: { ':p': filialId ? `STOCK#${filialId}#` : 'STOCK#' }, ExclusiveStartKey: cursor }));
      values.push(...(page.Items || []).map(item => item.value as Stock)); cursor = page.LastEvaluatedKey;
    } while (cursor);
    return values;
  }
  async createCatalog(stock: Stock): Promise<void> {
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.table, Item: { pk: `STOCK#${stock.filialId}#${stock.pecaId}`, value: stock }, ConditionExpression: 'attribute_not_exists(pk)' } },
        { Put: { TableName: this.table, Item: { pk: `CODE#${stock.filialId}#${stock.codigo}`, pecaId: stock.pecaId }, ConditionExpression: 'attribute_not_exists(pk)' } },
      ] }));
    } catch (error: any) { if (error.name === 'TransactionCanceledException') throw new Conflict('Piece code already registered in branch'); throw error; }
  }
  async updateCatalog(filialId: string, pecaId: string, patch: Partial<Stock>): Promise<Stock> {
    const names: Record<string, string> = { '#v': 'value' }, values: Record<string, any> = {};
    const sets = Object.entries(patch).map(([key, value], i) => { names[`#k${i}`] = key; values[`:v${i}`] = value; return `#v.#k${i}=:v${i}`; });
    const response = await this.db.send(new UpdateCommand({ TableName: this.table, Key: { pk: `STOCK#${filialId}#${pecaId}` },
      UpdateExpression: `SET ${sets.join(', ')}`, ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: names, ExpressionAttributeValues: values, ReturnValues: 'ALL_NEW' }));
    return response.Attributes!.value as Stock;
  }
  async addStock(filialId: string, pecaId: string, quantity: number): Promise<Stock> {
    const response = await this.db.send(new UpdateCommand({ TableName: this.table, Key: { pk: `STOCK#${filialId}#${pecaId}` },
      UpdateExpression: 'SET #v.#q = #v.#q + :q', ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#v': 'value', '#q': 'quantity' }, ExpressionAttributeValues: { ':q': quantity }, ReturnValues: 'ALL_NEW' }));
    return response.Attributes!.value as Stock;
  }
  async putStock(stock: Omit<Stock, 'reserved' | 'used'>): Promise<Stock> {
    const result = await this.db.send(new UpdateCommand({
      TableName: this.table, Key: { pk: `STOCK#${stock.filialId}#${stock.pecaId}` },
      UpdateExpression: 'SET #v.quantity=:q, #v.description=:d',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#v': 'value' },
      ExpressionAttributeValues: { ':q': stock.quantity, ':d': stock.description || '' }, ReturnValues: 'ALL_NEW',
    })).catch(async error => {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      try {
        await this.db.send(new TransactWriteCommand({ TransactItems: [{ Put: {
          TableName: this.table, Item: { pk: `STOCK#${stock.filialId}#${stock.pecaId}`, value: { ...stock, reserved: 0, used: 0 } }, ConditionExpression: 'attribute_not_exists(pk)',
        } }] }));
      } catch (createError: any) {
        if (createError.name !== 'TransactionCanceledException') throw createError;
        return this.putStock(stock).then(value => ({ Attributes: { value } }));
      }
      return { Attributes: { value: { ...stock, reserved: 0, used: 0 } } };
    });
    return result.Attributes!.value as Stock;
  }
  async commit(change: Commit): Promise<void> {
    const tx: any[] = [];
    const putUnique = (pk: string, item: object = {}) => tx.push({ Put: {
      TableName: this.table, Item: { pk, ...item }, ConditionExpression: 'attribute_not_exists(pk)',
    } });
    if (change.inbox) putUnique(`INBOX#${change.inbox}`, { expiresAt: Math.floor(Date.now() / 1000) + 604800 });
    if (change.step) putUnique(`STEP#${change.step}`);
    if (change.consumption) putUnique(`CONSUMPTION#${change.consumption.osId}#${change.consumption.operationId}`, { fingerprint: change.consumption.fingerprint });
    if (change.cancelSaga) tx.push({ Put: { TableName: this.table, Item: { pk: `CANCELLED#${change.cancelSaga}` } } });
    if (change.activeSaga) tx.push({ ConditionCheck: {
      TableName: this.table, Key: { pk: `CANCELLED#${change.activeSaga}` }, ConditionExpression: 'attribute_not_exists(pk)',
    } });
    if (change.order) {
      const order = change.order;
      tx.push({ Put: {
        TableName: this.table,
        Item: { pk: `ORDER#${order.osId}`, revision: order.revision, value: order, gsi1pk: `ORDERS#${order.filialId}`, gsi1sk: order.osId },
        ConditionExpression: change.expectedRevision === undefined ? 'attribute_not_exists(pk)' : 'revision = :revision',
        ...(change.expectedRevision === undefined ? {} : { ExpressionAttributeValues: { ':revision': change.expectedRevision } }),
      } });
    }
    for (const stock of change.stocks || []) {
      const reserve = stock.action === 'reserve', release = stock.action === 'release';
      tx.push({ Update: {
        TableName: this.table, Key: { pk: `STOCK#${stock.filialId}#${stock.pecaId}` },
        UpdateExpression: reserve ? 'SET #v.quantity = #v.quantity - :q, #v.reserved = #v.reserved + :q'
          : release ? 'SET #v.quantity = #v.quantity + :q, #v.reserved = #v.reserved - :q'
          : 'SET #v.reserved = #v.reserved - :q, #v.used = #v.used + :q',
        ConditionExpression: reserve ? '#v.quantity >= :q AND (attribute_not_exists(#v.ativo) OR #v.ativo = :active)' : '#v.reserved >= :q',
        ExpressionAttributeNames: { '#v': 'value' }, ExpressionAttributeValues: { ':q': stock.quantity, ...(reserve ? { ':active': true } : {}) },
      } });
    }
    for (const event of change.events) putUnique(`OUTBOX#${event.messageId}`, {
      event, gsi1pk: 'OUTBOX#PENDING', gsi1sk: event.occurredAt,
    });
    if (tx.length > 100) throw new Error('Transaction limit exceeded');
    try { await this.db.send(new TransactWriteCommand({ TransactItems: tx })); }
    catch (error: any) {
      if (error.name !== 'TransactionCanceledException') throw error;
      const stockStart = Number(!!change.inbox) + Number(!!change.step) + Number(!!change.consumption) + Number(!!change.cancelSaga) + Number(!!change.activeSaga) + Number(!!change.order);
      const stockFailure = error.CancellationReasons?.slice(stockStart, stockStart + (change.stocks?.length || 0)).some((r: any) => r.Code === 'ConditionalCheckFailed');
      if (stockFailure) throw new InsufficientStock('Insufficient stock or reservation');
      throw new Conflict('Concurrent change');
    }
  }
  async pending(): Promise<OutboxItem[]> {
    const result = await this.db.send(new QueryCommand({
      TableName: this.table, IndexName: 'pending-index', KeyConditionExpression: 'gsi1pk=:p',
      ExpressionAttributeValues: { ':p': 'OUTBOX#PENDING' }, Limit: 25,
    }));
    return (result.Items || []) as OutboxItem[];
  }
  async claim(pk: string, owner: string): Promise<boolean> {
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.table, Key: { pk },
        UpdateExpression: 'SET leaseOwner=:o, leaseUntil=:until',
        ConditionExpression: 'attribute_exists(gsi1pk) AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
        ExpressionAttributeValues: { ':o': owner, ':until': Date.now() + 30000, ':now': Date.now() },
      })); return true;
    } catch (error: any) { if (error.name === 'ConditionalCheckFailedException') return false; throw error; }
  }
  async sent(pk: string, owner: string): Promise<void> {
    await this.db.send(new UpdateCommand({
      TableName: this.table, Key: { pk }, UpdateExpression: 'SET expiresAt=:ttl REMOVE gsi1pk, gsi1sk, leaseUntil, leaseOwner',
      ConditionExpression: 'leaseOwner=:o', ExpressionAttributeValues: { ':ttl': Math.floor(Date.now() / 1000) + 604800, ':o': owner },
    }));
  }
}
