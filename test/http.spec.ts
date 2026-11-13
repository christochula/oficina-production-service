import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { InternalController, ProductionController } from '../src/production.controller';
import { HealthController } from '../src/health.controller';
import { ProductionService } from '../src/production.service';
import { InternalGuard, JwtGuard } from '../src/auth';
import { Store } from '../src/model';
import { MemoryStore } from './memory.store';

describe('HTTP authentication, ownership, validation and operator flow', () => {
  let app: INestApplication; let store: MemoryStore;
  const secret = 'test-secret-more-than-thirty-two-characters';
  const token = (sub = 'admin', role = 'ADMIN', extra = {}) => jwt.sign({ role, ...extra }, secret, { subject: sub, issuer: 'oficina-auth-serverless', audience: 'oficina-api', expiresIn: 3600 });
  const auth = (sub?: string, role?: string) => `Bearer ${token(sub, role)}`;
  const base = '/api/v1/production';
  beforeAll(async () => {
    process.env.JWT_SECRET = secret; process.env.AUTH_CLIENT_LOOKUP_TOKEN = secret;
    store = new MemoryStore();
    const module = await Test.createTestingModule({ controllers: [ProductionController, InternalController, HealthController], providers: [ProductionService, InternalGuard, JwtGuard, { provide: Store, useValue: store }] }).compile();
    app = module.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); await app.init();
  });
  afterAll(async () => { await app.close(); });
  const api = () => request(app.getHttpServer());
  it('protects internal creation/snapshot and validates bodies, while retrying creation idempotently', async () => {
    const body = { osId: 'os1', filialId: 'f1', clienteId: 'c1' };
    await api().post(`${base}/internal/orders`).send(body).expect(401);
    await api().post(`${base}/internal/orders`).set('X-Internal-Token', 'wrong').send(body).expect(401);
    await api().post(`${base}/internal/orders`).set('X-Internal-Token', secret).send({ ...body, surprise: true }).expect(400);
    await api().post(`${base}/internal/orders`).set('X-Internal-Token', secret).send(body).expect(201);
    await api().post(`${base}/internal/orders`).set('X-Internal-Token', secret).send(body).expect(201);
    const snapshot = await api().get(`${base}/internal/orders/os1`).set('X-Internal-Token', secret).expect(200);
    expect(snapshot.body).toMatchObject({ status: 'DIAGNOSIS', clienteId: 'c1', parts: [] });
    await api().get(`${base}/internal/orders/os1`).expect(401);
    const expected = process.env.AUTH_CLIENT_LOOKUP_TOKEN; delete process.env.AUTH_CLIENT_LOOKUP_TOKEN;
    await api().get(`${base}/internal/orders/os1`).set('X-Internal-Token', secret).expect(401);
    process.env.AUTH_CLIENT_LOOKUP_TOKEN = expected;
  });
  it('rejects missing, malformed, expired, wrong issuer/audience/algorithm/role tokens', async () => {
    const path = `${base}/orders/os1`;
    await api().get(path).expect(401);
    for (const value of ['Basic abc', 'Bearer garbage', `Bearer ${jwt.sign({role:'ADMIN'}, secret, {subject:'a',expiresIn:-1,issuer:'oficina-auth-serverless',audience:'oficina-api'})}`, `Bearer ${jwt.sign({role:'ADMIN'}, secret, {subject:'a',expiresIn:100,issuer:'other',audience:'oficina-api'})}`, `Bearer ${jwt.sign({role:'ADMIN'}, secret, {subject:'a',expiresIn:100,issuer:'oficina-auth-serverless',audience:'wrong'})}`, `Bearer ${jwt.sign({role:'ADMIN'}, secret, {algorithm:'HS384',subject:'a',expiresIn:100,issuer:'oficina-auth-serverless',audience:'oficina-api'})}`, `Bearer ${token('c1','CLIENTE',{client_id:42})}`, `Bearer ${token('a','ROOT')}`, `Bearer ${jwt.sign({role:'ADMIN'}, secret, {subject:'a',issuer:'oficina-auth-serverless',audience:'oficina-api'})}`, `Bearer ${jwt.sign({role:'ADMIN'}, secret, {expiresIn:100,issuer:'oficina-auth-serverless',audience:'oficina-api'})}`]) await api().get(path).set('Authorization',value).expect(401);
  });
  it('enforces administrator operations and owner reads/writes', async () => {
    await api().post(`${base}/orders/os1/assign`).set('Authorization', auth('c1','CLIENTE')).send({mecanicoId:'m1'}).expect(403);
    await api().post(`${base}/orders/os1/assign`).set('Authorization', auth()).send({mecanicoId:'m1'}).expect(201);
    await api().get(`${base}/orders/os1`).set('Authorization', auth('c1','CLIENTE')).expect(200);
    await api().get(`${base}/orders/os1`).set('Authorization', `Bearer ${token('c1','CLIENTE',{client_id:'c1'})}`).expect(200);
    await api().get(`${base}/orders/os1`).set('Authorization', `Bearer ${token('user1','CLIENTE',{client_id:'c1'})}`).expect(200);
    await api().get(`${base}/orders/os1`).set('Authorization', auth('c2','CLIENTE')).expect(403);
    await api().get(`${base}/orders/os1`).set('Authorization', auth('m2','MECANICO')).expect(403);
    await api().get(`${base}/orders/os1`).set('Authorization', auth('m1','MECANICO')).expect(200);
    await api().post(`${base}/orders/os1/diagnosis`).set('Authorization', auth('c1','CLIENTE')).send({descricao:'Repair'}).expect(403);
    await api().post(`${base}/orders/os1/diagnosis`).set('Authorization', auth('m1','MECANICO')).send({descricao:'Repair'}).expect(201);
    await api().put(`${base}/stock/p1`).set('Authorization', auth('m1','MECANICO')).send({filialId:'f1',quantity:10}).expect(403);
    await api().put(`${base}/stock/p1`).set('Authorization', auth()).send({filialId:'f1',quantity:10,description:'Filter'}).expect(200);
    await api().put(`${base}/stock/p1`).set('Authorization', auth()).send({filialId:'f1',quantity:-1}).expect(400);
  });
  it('filters queue by branch and authenticated ownership', async () => {
    await api().post(`${base}/internal/orders`).set('X-Internal-Token', secret).send({osId:'os2',filialId:'f2',clienteId:'c2'}).expect(201);
    expect((await api().get(`${base}/orders`).set('Authorization',auth()).expect(200)).body).toHaveLength(2);
    expect((await api().get(`${base}/orders?filialId=f1`).set('Authorization',auth()).expect(200)).body).toHaveLength(1);
    expect((await api().get(`${base}/orders`).set('Authorization',auth('c2','CLIENTE')).expect(200)).body.map((o:any)=>o.osId)).toEqual(['os2']);
  });
  it('executes confirmed work through HTTP and exposes health independently of JWT', async () => {
    const order = store.orders.get('os1')!; order.status='READY'; order.parts=[{pecaId:'p1',description:'Filter',quantity:1,consumedQuantity:0}];
    const stock = store.stocks.get('f1#p1')!; stock.reserved=1;
    await api().post(`${base}/orders/os1/start`).set('Authorization',auth('m1','MECANICO')).expect(201);
    await api().post(`${base}/orders/os1/consume`).set('Authorization',auth('m1','MECANICO')).send({pecaId:'p1',quantidade:1}).expect(201);
    await api().post(`${base}/orders/os1/complete`).set('Authorization',auth('m1','MECANICO')).expect(201);
    await api().get('/api/health/live').expect(200);
    await api().get('/api/v1/production/health').expect(200);
    await api().get('/api/health/ready').expect(200);
    jest.spyOn(store,'exists').mockRejectedValueOnce(new Error('offline'));
    await api().get('/api/v1/production/health').expect(503);
  });
  it('validates optional consumption UUIDs and replays only for an authorized actor', async () => {
    store.orders.set('consume-http', { osId:'consume-http',filialId:'fh',clienteId:'c1',mecanicoId:'m1',status:'IN_PROGRESS',revision:0,parts:[{pecaId:'ph',description:'Filter',quantity:2,consumedQuantity:0}] });
    store.stocks.set('fh#ph', {pecaId:'ph',filialId:'fh',quantity:3,reserved:2,used:0});
    const path=`${base}/orders/consume-http/consume`, operationId=randomUUID();
    for (const invalid of ['invalid',null,123]) await api().post(path).set('Authorization',auth('m1','MECANICO')).send({pecaId:'ph',quantidade:1,operationId:invalid}).expect(400);
    const body={pecaId:'ph',quantidade:1,operationId};
    const first=await api().post(path).set('Authorization',auth('m1','MECANICO')).send(body).expect(201);
    const replay=await api().post(path).set('Authorization',auth('m1','MECANICO')).send(body).expect(201);
    expect(replay.body).toEqual(first.body);
    await api().post(path).set('Authorization',auth('m2','MECANICO')).send(body).expect(403);
    await api().post(path).set('Authorization',auth('c1','CLIENTE')).send(body).expect(403);
    await api().post(path).set('Authorization',auth('m1','MECANICO')).send({...body,quantidade:2}).expect(409);
    await api().post(path).set('Authorization',auth('m1','MECANICO')).send({...body,operationId:randomUUID()}).expect(201);
    const completed=await api().post(`${base}/orders/consume-http/complete`).set('Authorization',auth('m1','MECANICO')).expect(201);
    const late=await api().post(path).set('Authorization',auth('m1','MECANICO')).send(body).expect(201);
    expect(late.body).toEqual(completed.body);
    expect(store.outbox.filter(item=>item.event.osId==='consume-http'&&item.event.type==='PartsConsumed')).toHaveLength(2);
    expect(store.stocks.get('fh#ph')).toMatchObject({reserved:0,used:2});
  });
});
