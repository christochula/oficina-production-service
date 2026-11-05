import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Actor, admin, assigner, InternalGuard, JwtGuard, ownership } from './auth';
import { AssignDto, ConsumeDto, CreateOrderDto, DiagnosisDto, StockDto } from './dto';
import { ProductionService } from './production.service';

@ApiTags('Production') @ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('api/v1/production')
export class ProductionController {
  constructor(private readonly service: ProductionService) {}
  @Get('orders')
  async list(@Req() req: { actor: Actor }, @Query('filialId') filialId?: string) {
    const rows = await this.service.list(filialId);
    return rows.filter(row => {
      try { ownership(req.actor, row); return true; } catch { return false; }
    });
  }
  @Get('orders/:osId')
  async get(@Req() req: { actor: Actor }, @Param('osId') osId: string) {
    const order = await this.service.get(osId); ownership(req.actor, order); return order;
  }
  @Post('orders/:osId/assign')
  assign(@Req() req: { actor: Actor }, @Param('osId') osId: string, @Body() body: AssignDto) {
    assigner(req.actor); return this.service.assign(osId, body.mecanicoId);
  }
  @Post('orders/:osId/diagnosis')
  async diagnosis(@Req() req: { actor: Actor }, @Param('osId') osId: string, @Body() body: DiagnosisDto) {
    ownership(req.actor, await this.service.get(osId), true); return this.service.diagnosis(osId, body.descricao,req.actor);
  }
  @Post('orders/:osId/start')
  async start(@Req() req: { actor: Actor }, @Param('osId') osId: string) {
    ownership(req.actor, await this.service.get(osId), true); return this.service.start(osId,req.actor);
  }
  @Post('orders/:osId/consume')
  async consume(@Req() req: { actor: Actor }, @Param('osId') osId: string, @Body() body: ConsumeDto) {
    ownership(req.actor, await this.service.get(osId), true); return this.service.consume(osId, body.pecaId, body.quantidade,req.actor);
  }
  @Post('orders/:osId/complete')
  async complete(@Req() req: { actor: Actor }, @Param('osId') osId: string) {
    ownership(req.actor, await this.service.get(osId), true); return this.service.complete(osId,req.actor);
  }
  @Put('stock/:pecaId')
  stock(@Req() req: { actor: Actor }, @Param('pecaId') pecaId: string, @Body() body: StockDto) {
    admin(req.actor); return this.service.stock(body.filialId, pecaId, body.quantity, body.description);
  }
}
@ApiTags('Internal') @ApiSecurity('internal-token') @UseGuards(InternalGuard)
@Controller('api/v1/production/internal/orders')
export class InternalController {
  constructor(private readonly service: ProductionService) {}
  @Post() create(@Body() body: CreateOrderDto) { return this.service.create(body); }
  @Get(':osId') get(@Param('osId') osId: string) { return this.service.get(osId); }
}
