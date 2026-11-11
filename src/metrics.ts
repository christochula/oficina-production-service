import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor, OnModuleDestroy } from '@nestjs/common';
import { createSocket, Socket } from 'node:dgram';
import { finalize, Observable, tap } from 'rxjs';

@Injectable()
export class Metrics implements OnModuleDestroy {
  private socket?: Socket;
  duration(method: string, status: number, durationMs: number): void {
    if (!Number.isFinite(durationMs)) return;
    this.emit(`oficina.api.request.duration_ms:${Math.max(0,durationMs)}|d`,[`method:${method.replace(/[^a-zA-Z0-9_.\/-]/g,'_')}`,`status_code:${status}`]);
  }
  messageProcessed(failed=false,queue='production-commands'):void {
    this.emit(`${failed?'oficina.messaging.failed':'oficina.messaging.processed'}:1|c`,[`queue:${queue.replace(/[^a-zA-Z0-9_.-]/g,'_')}`]);
  }
  private emit(sample:string,extraTags:string[]):void {
    if (process.env.DD_METRICS_ENABLED === 'false') return;
    const clean=(value:string)=>value.replace(/[^a-zA-Z0-9_.\/-]/g,'_');
    const tags=[`env:${clean(process.env.DD_ENV || 'local')}`,`service:${clean(process.env.DD_SERVICE || 'oficina-production-service')}`,
      `version:${clean(process.env.DD_VERSION || '4.0.0')}`,...extraTags];
    const payload=Buffer.from(`${sample}|#${tags.join(',')}`);
    try {
      if (!this.socket) { this.socket=createSocket('udp4'); this.socket.on('error',()=>{}); }
      this.socket.send(payload,Number(process.env.DD_DOGSTATSD_PORT || 8125),process.env.DD_AGENT_HOST || '127.0.0.1',()=>{});
    } catch { /* Telemetry must not fail a business request. */ }
  }
  onModuleDestroy(): void { if(this.socket) {try {this.socket.close();} catch { /* Socket was already closed. */ }} }
}
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics:Metrics) {}
  intercept(context:ExecutionContext,next:CallHandler):Observable<unknown> {
    const started=performance.now(),http=context.switchToHttp(),request=http.getRequest(),response=http.getResponse();
    let status:number|undefined;
    return next.handle().pipe(
      tap({error:(error:unknown)=>{status=error instanceof HttpException?error.getStatus():500;}}),
      finalize(()=>this.metrics.duration(request.method,status ?? response.statusCode,performance.now()-started)),
    );
  }
}
