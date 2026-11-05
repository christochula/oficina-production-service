import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { Order } from './model';
export interface Actor { sub: string; role: 'ADMIN' | 'ADMINISTRADOR' | 'CONSULTOR_TECNICO' | 'MECANICO' | 'CLIENTE'; client_id?: string }
@Injectable()
export class JwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    try {
      const header = req.headers.authorization;
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) throw new Error();
      const claims = jwt.verify(header.slice(7), process.env.JWT_SECRET!, {
        algorithms: ['HS256'], issuer: 'oficina-auth-serverless', audience: 'oficina-api',
      });
      if (typeof claims === 'string' || typeof claims.sub !== 'string' || !claims.sub || typeof claims.exp !== 'number' || !['ADMIN', 'ADMINISTRADOR', 'CONSULTOR_TECNICO', 'MECANICO', 'CLIENTE'].includes(claims.role)) throw new Error();
      if (claims.client_id !== undefined && (typeof claims.client_id !== 'string' || !claims.client_id)) throw new Error();
      req.actor = claims; return true;
    } catch { throw new UnauthorizedException('Invalid access token'); }
  }
}
@Injectable()
export class InternalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const supplied = context.switchToHttp().getRequest().headers['x-internal-token'];
    const expected = process.env.AUTH_CLIENT_LOOKUP_TOKEN;
    if (typeof supplied !== 'string' || !expected || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new UnauthorizedException('Invalid internal token');
    return true;
  }
}
export function admin(actor: Actor): void { if (!['ADMIN','ADMINISTRADOR'].includes(actor.role)) throw new ForbiddenException('Administrator required'); }
export function assigner(actor: Actor): void { if (!['ADMIN','ADMINISTRADOR','CONSULTOR_TECNICO'].includes(actor.role)) throw new ForbiddenException('Operator required'); }
export function ownership(actor: Actor, order: Order, write = false): void {
  if (['ADMIN','ADMINISTRADOR'].includes(actor.role) || (!write && actor.role === 'CONSULTOR_TECNICO') || (actor.role === 'MECANICO' && actor.sub === order.mecanicoId) || (!write && actor.role === 'CLIENTE' && (actor.client_id || actor.sub) === order.clienteId)) return;
  throw new ForbiddenException('Order access denied');
}
