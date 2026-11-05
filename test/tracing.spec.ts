jest.mock('dd-trace',()=>{
  const scope={active:jest.fn()};
  return {__esModule:true,default:{scope:()=>scope,inject:jest.fn()}};
});
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import tracer from 'dd-trace';
import { JwtGuard } from '../src/auth';
import { Envelope, Store } from '../src/model';
import { ProductionController } from '../src/production.controller';
import { ProductionService } from '../src/production.service';
import { activeTraceparent } from '../src/tracing';
import { MemoryStore } from './memory.store';

describe('W3C context at durable messaging boundaries',()=>{
  const incoming='00-11111111111111111111111111111111-2222222222222222-01';
  const active='00-11111111111111111111111111111111-3333333333333333-01';
  const span={id:'active-http-or-consumer-span'};
  const secret='trace-test-secret-with-at-least-32-characters';
  let app:INestApplication;let store:MemoryStore;let service:ProductionService;
  beforeAll(async()=>{
    process.env.JWT_SECRET=secret;store=new MemoryStore();service=new ProductionService(store);
    const module=await Test.createTestingModule({controllers:[ProductionController],providers:[JwtGuard,{provide:ProductionService,useValue:service},{provide:Store,useValue:store}]}).compile();
    app=module.createNestApplication();await app.init();
  });
  afterAll(async()=>app.close());
  beforeEach(()=>{(tracer.scope().active as jest.Mock).mockReturnValue(span);(tracer.inject as jest.Mock).mockImplementation((_span,_format,carrier)=>{carrier.traceparent=active;});});
  afterEach(()=>jest.clearAllMocks());
  it('persists active HTTP span context with the assignment event before publishing',async()=>{
    await service.create({osId:'http-order',filialId:'f1',clienteId:'c1'});
    const token=jwt.sign({role:'ADMINISTRADOR'},secret,{subject:'admin',issuer:'oficina-auth-serverless',audience:'oficina-api',expiresIn:3600});
    await request(app.getHttpServer()).post('/api/v1/production/orders/http-order/assign').set('Authorization',`Bearer ${token}`).send({mecanicoId:'m1'}).expect(201);
    expect(store.outbox.at(-1)?.event).toMatchObject({type:'MechanicAssigned',traceparent:active});
    expect(tracer.inject).toHaveBeenCalledWith(span,'http_headers',expect.any(Object));
  });
  it('prefers current consumer child span over incoming parent when persisting a reply',async()=>{
    const command:Envelope={messageId:'command-1',type:'CancelExecutionReservation',version:1,sagaId:'saga-1',osId:'command-order',filialId:'f1',correlationId:'corr-1',occurredAt:new Date().toISOString(),traceparent:incoming,payload:{}};
    await service.command(command);
    expect(store.outbox.at(-1)?.event).toMatchObject({type:'ExecutionCancelled',traceparent:active,correlationId:'corr-1'});
  });
  it('falls back to incoming context if there is no active span or tracecontext is unavailable',()=>{
    (tracer.scope().active as jest.Mock).mockReturnValue(null);
    expect(activeTraceparent(incoming)).toBe(incoming);expect(activeTraceparent()).toBeUndefined();
    (tracer.scope().active as jest.Mock).mockReturnValue(span);(tracer.inject as jest.Mock).mockImplementation(()=>{});
    expect(activeTraceparent(incoming)).toBe(incoming);
  });
  it('keeps business messages available when telemetry injection throws',()=>{
    (tracer.inject as jest.Mock).mockImplementation(()=>{throw new Error('tracer not ready');});
    expect(activeTraceparent(incoming)).toBe(incoming);
  });
});
