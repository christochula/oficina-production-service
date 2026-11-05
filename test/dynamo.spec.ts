import { DynamoStore } from '../src/dynamo.store';
import { Conflict, Envelope, InsufficientStock, Order } from '../src/model';
const event: Envelope = { messageId:'e1',type:'ExecutionReserved',version:1,sagaId:'s1',osId:'o1',filialId:'f1',correlationId:'c1',occurredAt:'2026-11-04T12:00:00Z',payload:{} };
const order: Order = { osId:'o1',filialId:'f1',clienteId:'c1',status:'RESERVED',parts:[],revision:1 };
describe('DynamoDB atomic adapter', () => {
  let store: DynamoStore; let send: jest.Mock;
  beforeEach(() => { store = new DynamoStore(); send=jest.fn().mockResolvedValue({}); (store as any).db={send}; });
  const namedError = (name:string, more={}) => Object.assign(new Error(name),{name,...more});
  it('reads individual aggregate/stock with strong consistency and existence markers', async () => {
    send.mockResolvedValueOnce({Item:{value:order}}).mockResolvedValueOnce({Item:{value:{quantity:3}}}).mockResolvedValueOnce({Item:{pk:'x'}}).mockResolvedValueOnce({});
    expect(await store.getOrder('o1')).toEqual(order); expect(await store.getStock('f1','p1')).toEqual({quantity:3});
    expect(await store.exists('x')).toBe(true); expect(await store.getOrder('absent')).toBeUndefined();
    expect(send.mock.calls[0][0].input).toMatchObject({ConsistentRead:true,Key:{pk:'ORDER#o1'}});
  });
  it('paginates branch queue queries and admin scan without assuming one page', async () => {
    send.mockResolvedValueOnce({Items:[{value:order}],LastEvaluatedKey:{pk:'cursor'}}).mockResolvedValueOnce({Items:[{value:{...order,osId:'o2'}}]});
    expect(await store.listOrders('f1')).toHaveLength(2);
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({pk:'cursor'});
    send.mockResolvedValueOnce({}); expect(await store.listOrders()).toEqual([]);
    expect(send.mock.calls[2][0].constructor.name).toBe('ScanCommand');
  });
  it('atomically writes order, inbox, saga step, outbox and all stock changes', async () => {
    await store.commit({order,expectedRevision:0,inbox:'m1',step:'s1#ReserveExecution',activeSaga:'s1',stocks:[{filialId:'f1',pecaId:'p1',quantity:2,action:'reserve'},{filialId:'f1',pecaId:'p2',quantity:1,action:'release'},{filialId:'f1',pecaId:'p3',quantity:1,action:'consume'}],events:[event]});
    const tx = send.mock.calls[0][0].input.TransactItems;
    expect(tx).toHaveLength(8);
    expect(tx[0].Put.Item.pk).toBe('INBOX#m1'); expect(tx[0].Put.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(tx[2].ConditionCheck.Key.pk).toBe('CANCELLED#s1');
    expect(tx[3].Put.ExpressionAttributeValues).toEqual({':revision':0});
    expect(tx[4].Update.ConditionExpression).toContain('#v.quantity >= :q');
    expect(tx[5].Update.UpdateExpression).toContain('quantity + :q'); expect(tx[6].Update.UpdateExpression).toContain('used + :q');
    expect(tx[7].Put.Item).toMatchObject({event,gsi1pk:'OUTBOX#PENDING'});
  });
  it('creates order conditionally and cancellation tombstones independently of aggregate existence', async () => {
    await store.commit({order,events:[]});
    expect(send.mock.calls[0][0].input.TransactItems[0].Put.ConditionExpression).toBe('attribute_not_exists(pk)');
    await store.commit({cancelSaga:'s1',events:[event]});
    expect(send.mock.calls[1][0].input.TransactItems[0].Put.Item.pk).toBe('CANCELLED#s1');
  });
  it('maps conditional stock failures, optimistic conflicts, service failures and transaction size violations', async () => {
    send.mockRejectedValueOnce(namedError('TransactionCanceledException',{CancellationReasons:[{Code:'ConditionalCheckFailed'}]}));
    await expect(store.commit({stocks:[{filialId:'f',pecaId:'p',quantity:2,action:'reserve'}],events:[]})).rejects.toBeInstanceOf(InsufficientStock);
    send.mockRejectedValueOnce(namedError('TransactionCanceledException')); await expect(store.commit({order,events:[]})).rejects.toBeInstanceOf(Conflict);
    send.mockRejectedValueOnce(new Error('network')); await expect(store.commit({events:[]})).rejects.toThrow('network');
    await expect(store.commit({events:Array(101).fill(event)})).rejects.toThrow('Transaction limit');
  });
  it('updates available stock without resetting reservations and creates missing stock conditionally', async () => {
    send.mockResolvedValueOnce({Attributes:{value:{quantity:2,reserved:3,used:1}}});
    expect(await store.putStock({filialId:'f',pecaId:'p',quantity:2})).toEqual({quantity:2,reserved:3,used:1});
    expect(send.mock.calls[0][0].input.UpdateExpression).not.toContain('reserved');
    send.mockRejectedValueOnce(namedError('ConditionalCheckFailedException')).mockResolvedValueOnce({});
    expect(await store.putStock({filialId:'f',pecaId:'p2',quantity:5,description:'test'})).toMatchObject({quantity:5,reserved:0,used:0});
  });
  it('retries concurrent stock creation and propagates unexpected update/create failures', async () => {
    send.mockRejectedValueOnce(namedError('ConditionalCheckFailedException')).mockRejectedValueOnce(namedError('TransactionCanceledException')).mockResolvedValueOnce({Attributes:{value:{quantity:5,reserved:1}}});
    expect(await store.putStock({filialId:'f',pecaId:'p',quantity:5})).toMatchObject({reserved:1});
    send.mockRejectedValueOnce(new Error('network')); await expect(store.putStock({filialId:'f',pecaId:'p',quantity:5})).rejects.toThrow('network');
    send.mockRejectedValueOnce(namedError('ConditionalCheckFailedException')).mockRejectedValueOnce(new Error('create offline'));
    await expect(store.putStock({filialId:'f',pecaId:'p',quantity:5})).rejects.toThrow('create offline');
  });
  it('leases durable outbox deliveries and deletes index keys only after successful delivery', async () => {
    send.mockResolvedValueOnce({Items:[{pk:'out',event}]}).mockResolvedValueOnce({});
    expect(await store.pending()).toEqual([{pk:'out',event}]); expect(await store.pending()).toEqual([]);
    expect(await store.claim('out','worker1')).toBe(true);
    send.mockRejectedValueOnce(namedError('ConditionalCheckFailedException')); expect(await store.claim('out','worker2')).toBe(false);
    send.mockRejectedValueOnce(new Error('network')); await expect(store.claim('out','worker3')).rejects.toThrow('network');
    await store.sent('out','worker1');
    expect(send.mock.calls.at(-1)[0].input).toMatchObject({ConditionExpression:'leaseOwner=:o',UpdateExpression:expect.stringContaining('REMOVE gsi1pk')});
  });
  it('paginates inventory scans, conditionally creates unique branch catalog and preserves metadata writes', async () => {
    send.mockResolvedValueOnce({Items:[{value:{pecaId:'p1'}}],LastEvaluatedKey:{pk:'cursor'}}).mockResolvedValueOnce({});
    expect(await store.listStock('f1')).toEqual([{pecaId:'p1'}]);
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues).toEqual({':p':'STOCK#f1#'});
    await store.listStock();
    const stock={pecaId:'p',filialId:'f',quantity:1,reserved:0,used:0,codigo:'CODE'};
    await store.createCatalog(stock);
    expect(send.mock.calls.at(-1)[0].input.TransactItems[1].Put.Item.pk).toBe('CODE#f#CODE');
    send.mockRejectedValueOnce(namedError('TransactionCanceledException'));await expect(store.createCatalog(stock)).rejects.toBeInstanceOf(Conflict);
    send.mockRejectedValueOnce(new Error('network'));await expect(store.createCatalog(stock)).rejects.toThrow('network');
    send.mockResolvedValueOnce({Attributes:{value:{...stock,nome:'Renamed'}}});
    expect((await store.updateCatalog('f','p',{nome:'Renamed'})).nome).toBe('Renamed');
    expect(send.mock.calls.at(-1)[0].input.ExpressionAttributeNames).toMatchObject({'#k0':'nome'});
    send.mockResolvedValueOnce({Attributes:{value:{...stock,quantity:4}}});
    expect((await store.addStock('f','p',3)).quantity).toBe(4);
    expect(send.mock.calls.at(-1)[0].input.UpdateExpression).toContain('#v.#q + :q');
  });
});
