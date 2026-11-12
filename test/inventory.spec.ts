import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { InternalInventoryController, InventoryController, InventoryService, legacyStock } from '../src/inventory';
import { InternalGuard, JwtGuard } from '../src/auth';
import { Store } from '../src/model';
import { MemoryStore } from './memory.store';
describe('Inventory owns catalog, available balance and branch stock',()=>{
  let app:INestApplication; let store:MemoryStore; let id:string;
  const secret='inventory-test-secret-at-least-32-characters';
  const auth=(role='ADMINISTRADOR')=>'Bearer '+jwt.sign({role},secret,{subject:'u1',issuer:'oficina-auth-serverless',audience:'oficina-api',expiresIn:3600});
  const base='/api/v1/production/inventory';
  const api=()=>request(app.getHttpServer());
  beforeAll(async()=>{
    process.env.JWT_SECRET=secret;store=new MemoryStore();
    const module=await Test.createTestingModule({controllers:[InventoryController],providers:[InventoryService,JwtGuard,{provide:Store,useValue:store}]}).compile();
    app=module.createNestApplication();app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.init();
  });
  afterAll(async()=>app.close());
  it('creates real catalog with default branch, prevents duplicate code, and filters/paginates stock',async()=>{
    const created=await api().post(base).set('Authorization',auth()).send({codigo:'FILTER',nome:'Filtro',precoVenda:10.5,quantidadeInicial:5,quantidadeMinima:2}).expect(201);
    id=created.body.peca.id; expect(created.body).toMatchObject({filialId:'filial-sp',quantidadeDisponivel:5,peca:{nome:'Filtro',ativo:true}});
    await api().post(base).set('Authorization',auth()).send({codigo:'FILTER',nome:'Other',precoVenda:10}).expect(409);
    await api().post(base).set('Authorization',auth()).send({codigo:'FILTER',nome:'Other',precoVenda:10,filialId:'filial-rj'}).expect(201);
    expect((await api().get(base+'?filialId=filial-sp&pagina=1&porPagina=1').set('Authorization',auth('MECANICO')).expect(200)).body.meta.total).toBe(1);
    expect((await api().get(base).set('Authorization',auth()).expect(200)).body.meta.total).toBe(2);
    await api().get(base+'?porPagina=101').set('Authorization',auth()).expect(400);
    await api().get(base+'?pagina=0').set('Authorization',auth()).expect(400);
    await api().get(base+'?pagina=1.5').set('Authorization',auth()).expect(400);
  });
  it('reads individual catalog, updates metadata and performs additive atomic stock entry',async()=>{
    await api().get(`${base}/${id}?filialId=filial-sp`).set('Authorization',auth('MECANICO')).expect(200);
    await api().get(`${base}/${id}`).set('Authorization',auth()).expect(200);
    const current=store.stocks.get(`filial-sp#${id}`)!;current.reserved=2;
    await api().patch(`${base}/${id}`).set('Authorization',auth()).send({nome:'Filtro melhor',descricao:null,precoVenda:12,quantidadeMinima:3}).expect(200);
    const entry=await api().patch(`${base}/${id}/entrada?filialId=filial-sp`).set('Authorization',auth()).send({quantidade:4}).expect(200);
    expect(entry.body).toMatchObject({quantidadeDisponivel:9,quantidadeReservada:2,peca:{nome:'Filtro melhor',precoVenda:12}});
    await api().patch(`${base}/${id}/desativar`).set('Authorization',auth()).expect(200);
    expect((await api().get(`${base}/${id}`).set('Authorization',auth()).expect(200)).body.peca.ativo).toBe(false);
    await api().patch(`${base}/${id}/ativar`).set('Authorization',auth()).expect(200);
    await api().patch(`${base}/${id}`).set('Authorization',auth()).send({}).expect(400);
    await api().patch(`${base}/${id}/entrada`).set('Authorization',auth()).send({quantidade:0.5}).expect(400);
  });
  it('rejects unauthorized changes, clients/consultants reads and nonexistent inventory',async()=>{
    await api().get(base).set('Authorization',auth('CLIENTE')).expect(403);
    await api().get(base).set('Authorization',auth('CONSULTOR_TECNICO')).expect(403);
    await api().post(base).set('Authorization',auth('MECANICO')).send({codigo:'x',nome:'Peça',precoVenda:1}).expect(403);
    await api().get(base+'/missing').set('Authorization',auth()).expect(404);
    await api().get(base+'/missing?filialId=missing').set('Authorization',auth()).expect(404);
    await api().post(base).set('Authorization',auth()).send({codigo:'x',nome:'Peça',precoVenda:1,quantidadeInicial:0.2}).expect(400);
    const baseStock={pecaId:'duplicate',quantity:0,reserved:0,used:0};
    store.stocks.set('a#duplicate',{...baseStock,filialId:'a'});store.stocks.set('b#duplicate',{...baseStock,filialId:'b'});
    await api().get(base+'/duplicate').set('Authorization',auth()).expect(409);
    expect(legacyStock({...baseStock,filialId:'a',description:'Fallback'})).toMatchObject({quantidadeMinima:0,peca:{nome:'Fallback',precoVenda:0,ativo:true}});
    expect(legacyStock({...baseStock,filialId:'a'}).peca.nome).toBe('duplicate');
  });
  it('preserves infrastructure errors rather than reporting false successful creation',async()=>{
    jest.spyOn(store,'createCatalog').mockRejectedValueOnce(new Error('network'));
    await api().post(base).set('Authorization',auth()).send({codigo:'NEW',nome:'Peça',precoVenda:1}).expect(500);
  });
});

describe('Inventory lookup across pages and authoritative internal identity', () => {
  let app: INestApplication; let store: MemoryStore;
  const secret = 'inventory-search-secret-at-least-32-characters';
  const auth = (role = 'MECANICO') => 'Bearer ' + jwt.sign({ role }, secret, { subject: 'm1', issuer: 'oficina-auth-serverless', audience: 'oficina-api', expiresIn: 3600 });
  const base = '/api/v1/production/inventory';
  const api = () => request(app.getHttpServer());
  beforeAll(async () => {
    process.env.JWT_SECRET = secret; process.env.AUTH_CLIENT_LOOKUP_TOKEN = secret;
    store = new MemoryStore();
    for (let n = 0; n < 34; n++) await store.createCatalog({ pecaId: `p${n}`, filialId: 'sp', codigo: `ARR-${n}`, nome: `Arruela ${n}`, ativo: true, quantity: 10, reserved: 0, used: 0 });
    for (const filialId of ['sp', 'rj']) await store.createCatalog({ pecaId: `oil-${filialId}`, filialId, codigo: 'OLEO-50', nome: 'Z Filtro de Óleo', descricao: 'Elemento sintético — carcaça azul', precoVenda: 50, ativo: true, quantity: 0, reserved: 0, used: 0 });
    await store.createCatalog({ pecaId: 'inactive', filialId: 'sp', codigo: 'OLD', nome: 'Z Filtro de Óleo antigo', ativo: false, quantity: 4, reserved: 0, used: 0 });
    await store.createCatalog({ pecaId: 'legacy', filialId: 'sp', codigo: 'LEGACY', description: 'Peça sem atributo ativo', quantity: 1, reserved: 0, used: 0 });
    const module = await Test.createTestingModule({ controllers: [InventoryController, InternalInventoryController], providers: [InventoryService, JwtGuard, InternalGuard, { provide: Store, useValue: store }] }).compile();
    app = module.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); await app.init();
  });
  afterAll(async () => app.close());
  it.each(['FILTRO DE OLEO', 'elemento sintetico', 'oleo-50'])('finds %s outside page one before pagination, preserving zero-stock identity', async busca => {
    const result = await api().get(base).query({ busca, filialId: 'sp', ativo: 'true', porPagina: '1', pagina: '1' }).set('Authorization', auth()).expect(200);
    expect(result.body).toMatchObject({ data: [{ filialId: 'sp', peca: { id: 'oil-sp', codigo: 'OLEO-50', ativo: true }, quantidadeDisponivel: 0 }], meta: { pagina: 1, porPagina: 1, total: 1, totalPaginas: 1 } });
  });
  it('keeps same-code branches distinct and paginates identical labels deterministically', async () => {
    const first = await api().get(base).query({ busca: 'OLEO-50', ativo: 'true', porPagina: 1 }).set('Authorization', auth()).expect(200);
    const second = await api().get(base).query({ busca: 'OLEO-50', ativo: 'true', porPagina: 1, pagina: 2 }).set('Authorization', auth()).expect(200);
    expect(first.body.meta).toMatchObject({ total: 2, totalPaginas: 2 });
    expect(first.body.data[0].filialId).toBe('rj'); expect(second.body.data[0].filialId).toBe('sp');
    const again = await api().get(base).query({ busca: 'OLEO-50', ativo: 'true', porPagina: 1 }).set('Authorization', auth()).expect(200);
    expect(again.body).toEqual(first.body);
  });
  it('returns filtered totals for inactive, legacy active and empty results without inventing matches', async () => {
    expect((await api().get(base).query({ ativo: 'false' }).set('Authorization', auth()).expect(200)).body).toMatchObject({ data: [{ peca: { id: 'inactive', ativo: false } }], meta: { total: 1 } });
    expect((await api().get(base).query({ busca: 'sem atributo', ativo: 'true' }).set('Authorization', auth()).expect(200)).body.data[0].peca.id).toBe('legacy');
    expect((await api().get(base).query({ busca: 'Não existe', pagina: 2 }).set('Authorization', auth()).expect(200)).body).toEqual({ data: [], meta: { pagina: 2, porPagina: 20, total: 0, totalPaginas: 0 } });
    expect((await api().get(base).query({ busca: '   ' }).set('Authorization', auth()).expect(200)).body.meta.total).toBe(38);
    for (const query of [{ ativo: 'yes' }, { busca: 'x'.repeat(201) }]) await api().get(base).query(query).set('Authorization', auth()).expect(400);
    await api().get(base + '?busca=a&busca=b').set('Authorization', auth()).expect(400);
  });
  it('restricts internal identity lookup to the internal token and explicit branch, without granting consultant stock reads', async () => {
    const internal = '/api/v1/production/internal/inventory/oil-sp';
    await api().get(internal).query({ filialId: 'sp' }).set('Authorization', auth('CONSULTOR_TECNICO')).expect(401);
    await api().get(internal).query({ filialId: 'sp' }).set('X-Internal-Token', 'wrong').expect(401);
    await api().get(internal).set('X-Internal-Token', secret).expect(400);
    await api().get(internal).query({ filialId: 'rj' }).set('X-Internal-Token', secret).expect(404);
    const identity = await api().get(internal).query({ filialId: 'sp' }).set('X-Internal-Token', secret).expect(200);
    expect(identity.body).toMatchObject({ filialId: 'sp', peca: { id: 'oil-sp', nome: 'Z Filtro de Óleo', codigo: 'OLEO-50', ativo: true } });
    expect((await api().get('/api/v1/production/internal/inventory/inactive').query({ filialId: 'sp' }).set('X-Internal-Token', secret).expect(200)).body.peca.ativo).toBe(false);
    await api().get(base).query({ busca: 'oil', ativo: 'true' }).set('Authorization', auth('CONSULTOR_TECNICO')).expect(403);
  });
});
