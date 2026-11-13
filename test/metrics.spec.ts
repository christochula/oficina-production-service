jest.mock('node:dgram',()=>({createSocket:jest.fn()}));
import { createSocket } from 'node:dgram';
import { BadRequestException, CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { Metrics, MetricsInterceptor } from '../src/metrics';
describe('DogStatsD duration contract',()=>{
  let metrics:Metrics;const send=jest.fn(),close=jest.fn(),on=jest.fn();
  beforeEach(()=>{metrics=new Metrics();(createSocket as jest.Mock).mockReturnValue({send,close,on});delete process.env.DD_METRICS_ENABLED;});
  afterEach(()=>{metrics.onModuleDestroy();jest.clearAllMocks();for(const key of ['DD_METRICS_ENABLED','DD_ENV','DD_AGENT_HOST','DD_DOGSTATSD_PORT','DD_SERVICE','DD_VERSION'])delete process.env[key];});
  it('emits a distribution in milliseconds with matching low-cardinality monitor tags',()=>{
    process.env.DD_ENV='homolog';process.env.DD_AGENT_HOST='10.0.0.1';process.env.DD_VERSION='abc123';
    metrics.duration('GET',200,12.5);
    expect(send.mock.calls[0][0].toString()).toBe('oficina.api.request.duration_ms:12.5|d|#env:homolog,service:oficina-production-service,version:abc123,method:GET,status_code:200');
    expect(send.mock.calls[0].slice(1,3)).toEqual([8125,'10.0.0.1']);send.mock.calls[0][3]();
    on.mock.calls[0][1](new Error('UDP unavailable'));
    metrics.duration('GET',200,1);expect(createSocket).toHaveBeenCalledTimes(1);
  });
  it('respects disable flag, defaults/sanitizes tags, clamps durations, and isolates telemetry failures',()=>{
    process.env.DD_METRICS_ENABLED='false';metrics.duration('GET',200,1);expect(send).not.toHaveBeenCalled();
    delete process.env.DD_METRICS_ENABLED;process.env.DD_SERVICE='production:bad|tag';process.env.DD_DOGSTATSD_PORT='8126';
    metrics.duration('POST',201,-1);expect(send.mock.calls[0][0].toString()).toContain(':0|d|#env:local,service:production_bad_tag,version:4.0.0');
    expect(send.mock.calls[0].slice(1,3)).toEqual([8126,'127.0.0.1']);
    send.mockImplementationOnce(()=>{throw new Error('UDP down');});expect(()=>metrics.duration('GET',200,1)).not.toThrow();
    close.mockImplementationOnce(()=>{throw new Error('already closed');});expect(()=>metrics.onModuleDestroy()).not.toThrow();
  });
  it('measures successful and rejected HTTP requests with actual outcome status',async()=>{
    const duration=jest.spyOn(metrics,'duration').mockImplementation(()=>{});
    const context={switchToHttp:()=>({getRequest:()=>({method:'PATCH'}),getResponse:()=>({statusCode:201})})} as unknown as ExecutionContext;
    const interceptor=new MetricsInterceptor(metrics);
    await lastValueFrom(interceptor.intercept(context,{handle:()=>of('ok')} as CallHandler));expect(duration.mock.calls[0].slice(0,2)).toEqual(['PATCH',201]);
    await expect(lastValueFrom(interceptor.intercept(context,{handle:()=>throwError(()=>new BadRequestException())}))).rejects.toBeInstanceOf(BadRequestException);
    expect(duration.mock.calls[1][1]).toBe(400);
    await expect(lastValueFrom(interceptor.intercept(context,{handle:()=>throwError(()=>new Error('offline'))}))).rejects.toThrow('offline');expect(duration.mock.calls[2][1]).toBe(500);
  });
  it('emits processed/failed counts under the same dashboard metric contract',()=>{
    metrics.messageProcessed();metrics.messageProcessed(true);
    expect(send.mock.calls[0][0].toString()).toBe('oficina.messaging.processed:1|c|#env:local,service:oficina-production-service,version:4.0.0,queue:production-commands');
    expect(send.mock.calls[1][0].toString()).toContain('oficina.messaging.failed:1|c|#');
    process.env.DD_METRICS_ENABLED='false';metrics.messageProcessed(true);expect(send).toHaveBeenCalledTimes(2);
    metrics.duration('GET',200,NaN);expect(send).toHaveBeenCalledTimes(2);
  });
});
