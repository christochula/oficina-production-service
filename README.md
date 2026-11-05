# Oficina Production Service — Fase 4

Microsserviço NestJS/TypeScript independente para diagnóstico, atribuição de mecânico, reserva de peças, fila de reparos e conclusão da produção. Possui exclusivamente sua tabela DynamoDB, infraestrutura Terraform, ECR, filas SQS, imagem Docker e release Helm. Nenhum acesso aos bancos de OS/Billing.

## Fluxo e limites do domínio

`DIAGNOSIS → RESERVED → READY → IN_PROGRESS → COMPLETED`. OS cria o snapshot interno, administrador atribui mecânico, mecânico registra diagnóstico, Billing prepara orçamento e OS orquestra `ReserveExecution → ConfirmExecution`. A confirmação libera o reparo. Após concluir, `ProductionCompleted` avisa OS para iniciar cobrança; pagamento pertence ao Billing e ocorre **depois do reparo**.

Reservas em `RESERVED/READY` podem ser compensadas com `CancelExecutionReservation`: estoque reservado retorna à quantidade disponível e a ordem fica `CANCELLED`. Retry explícito do OS pode reservar novamente com uma **nova sagaId**, preservando diagnóstico/mecânico; mensagens da Saga anterior continuam bloqueadas pelo tombstone. Trabalho iniciado/concluído nunca recebe rollback fictício. Falha de pagamento mantém a OS aguardando pagamento em seu serviço proprietário.

A Saga é **orquestrada pelo OS Service**: centraliza os passos e sua compensação, enquanto Production executa transações locais. Evita regras do fluxo distribuídas por diversos consumidores. Production não chama banco/API de outro serviço para executar uma transação local.

## API e autenticação

Porta padrão `3002`. Swagger em `/api/docs`, JSON em `/api/docs-json`; contrato exportado em [`docs/openapi.json`](docs/openapi.json). Executar `npm run build && npm run docs` para atualizar.

| Método e rota | Acesso / comportamento |
| --- | --- |
| `POST /api/v1/production/internal/orders` | `X-Internal-Token`, body `{osId,filialId,clienteId,mecanicoId?}`; criação idempotente sem reset |
| `GET /api/v1/production/internal/orders/:osId` | `X-Internal-Token`; snapshot para OS |
| `GET /api/v1/production/orders?filialId=` | JWT; fila filtrada pela propriedade e opcionalmente filial |
| `GET /api/v1/production/orders/:osId` | JWT; administrador, mecânico atribuído ou cliente proprietário |
| `POST /api/v1/production/orders/:osId/assign` | administrador; `{mecanicoId}` |
| `POST /api/v1/production/orders/:osId/diagnosis` | administrador/mecânico atribuído; `{descricao}` |
| `POST /api/v1/production/orders/:osId/start` | administrador/mecânico atribuído; exige `READY` |
| `POST /api/v1/production/orders/:osId/consume` | administrador/mecânico atribuído; `{pecaId,quantidade}`; limitado à reserva desta OS |
| `POST /api/v1/production/orders/:osId/complete` | administrador/mecânico atribuído; exige consumo de todas as peças reservadas |
| `PUT /api/v1/production/stock/:pecaId` | administrador; `{filialId,quantity,description?}`; `quantity` é quantidade disponível, preserva reservas/consumo |
| `GET /api/v1/production/health` | público; readiness consulta DynamoDB |
| `GET /api/health/live` | público; liveness do processo |

JWT compartilhado com auth: assinatura **HS256**, issuer `oficina-auth-serverless`, audience `oficina-api`, `exp`, `sub` e `role` obrigatórios. Roles: `ADMINISTRADOR` (alias `ADMIN`), `CONSULTOR_TECNICO`, `MECANICO`, `CLIENTE`. Consultor lê ordens e atribui mecânico; administrador gerencia estoque. Mecânico usa `sub` como `mecanicoId`; cliente usa `client_id` assinado quando presente, ou `sub`, e nunca altera produção. O cliente vinculado a um usuário pode ter `client_id` distinto de `sub`. A posse da OS é verificada novamente a cada retry transacional de escrita, inclusive após uma atribuição concorrente.

Catálogo/estoque para o portal: `/api/v1/production/inventory` (`GET` paginado, `POST` cadastro), `/:id` (`GET`, `PATCH` metadados), `/:id/entrada`, `/:id/ativar`, `/:id/desativar` (`PATCH`). Query `filialId` identifica o saldo da filial; cadastro permite código igual em filiais diferentes e impede duplicidade na mesma filial. Cadastro/entrada usam unidades inteiras; entrada faz incremento atômico sem sobrescrever reservas concorrentes. Código da peça é imutável. O OS expõe a fachada HTTP `/api/v1/estoque` para compatibilidade do portal e mantém todos os dados no Production, sem tabela SQL duplicada. Mecânicos podem consultar estoque, somente administradores alteram.

## Mensageria, consistência e compensação

Envelope v1: `{messageId,type,version:1,sagaId,osId,filialId,correlationId,occurredAt,traceparent?,payload}`. `INBOX_QUEUE_URL` recebe comandos e `OS_QUEUE_URL` recebe eventos. A fila de Production é standard SQS com entrega pelo menos uma vez; o publisher também aceita destino OS FIFO, preenchendo MessageGroupId=osId e MessageDeduplicationId=messageId. Não existe promessa de entrega exatamente uma vez.

Comandos: `ReserveExecution` com `payload.budget={items:[{description,quantity,unitPriceCents,pecaId?}],totalCents,version}`, `ConfirmExecution`, `CancelExecutionReservation`. Valores em centavos inteiros e total consistente; até 50 itens. Linhas da mesma peça são agregadas antes da reserva. Diagnóstico e mecânico são obrigatórios antes de reservar.

Eventos: `ExecutionReserved`, `ExecutionReady`, `ExecutionCancelled`, `ExecutionStarted`, `ProductionCompleted`, `MechanicAssigned {mecanicoId}`, `DiagnosisRecorded {descricao}`, `PartsConsumed {pecaId,quantidade}`. Falhas de domínio retornam `CommandFailed {commandType,reason}` via outbox, sem mutação parcial. Mensagens inválidas/falhas de infraestrutura não são confirmadas; SQS tenta novamente e encaminha à DLQ após cinco recebimentos.

Uma única `TransactWriteItems` grava alteração da ordem com controle de versão, mutações condicionais de estoque, inbox, marcador permanente do passo `(osId,sagaId,type)` e outbox. Assim, uma peça sem saldo aborta a reserva inteira; duplicatas não reservam nem compensam duas vezes. Cancelamento grava tombstone mesmo sem existir ordem. Reserva/confirmação verificam ausência do tombstone dentro da mesma transação, impedindo reabertura por mensagem tardia.

Outbox persistente usa GSI `pending-index` e lease condicional de 30s; envio SQS vem antes da remoção do índice. Queda após envio pode repetir evento; OS deve deduplicar `messageId`. Inbox e eventos enviados têm TTL de sete dias; marcadores de passos/tombstones não expiram. Leitura individual é consistente; fila por filial usa GSI eventualmente consistente. Consulta administrativa sem filial percorre a tabela paginada: para operação nacional, deve ganhar índice dedicado/paginação de API antes de alto volume.

### Modelo DynamoDB

Tabela exclusiva, chave string `pk`: `ORDER#osId`, `STOCK#filialId#pecaId`, `CODE#filialId#codigo`, `INBOX#messageId`, `STEP#osId#sagaId#type`, `CANCELLED#sagaId`, `OUTBOX#messageId`. GSI: hash `gsi1pk`, sort `gsi1sk`, projeção ALL; TTL `expiresAt`. Ordens indexadas por `ORDERS#filialId`; outbox por `OUTBOX#PENDING`. Cadastro da peça e marcador de código único são escritos juntos em transação. Proibido reutilizar esta tabela por outro serviço.

## Desenvolvimento e validação

Node 22. Instalar com `npm ci --ignore-scripts`, configurar `.env.example` no ambiente do processo e executar `npm run build && npm start`. O app não carrega `.env` automaticamente; pode usar `node --env-file=.env --require dd-trace/init dist/main.js`. LocalStack requer DynamoDB/SQS, tabela e filas conforme modelo acima; `AWS_ENDPOINT_URL` e credenciais locais `test` atendem os dois SDKs. Compose/BDD de integração vivem no workspace de entrega, fora deste repositório autônomo.

```bash
npm run typecheck
npm run test:cov
npm run build
npm run docs
docker build -t oficina-production-service:local .
```

**Evidência local:** 59 testes aprovados; cobertura global statements/lines/functions 100%, branches 98,46% (6 suítes: domínio, HTTP/JWT, inventário, adaptador DynamoDB, SQS e telemetria). Resumo medido versionado em [`docs/coverage-summary.json`](docs/coverage-summary.json). O relatório real é gerado em `coverage/lcov-report/index.html` e publicado como artifact `production-coverage` em cada CI. A cobertura inclui controllers, guards, mensageria e persistência; exclui somente bootstrap/wiring, interfaces e DTOs declarativos. Não inclui execução na AWS real; o fluxo entre os três serviços é validado separadamente no BDD integrado com PostgreSQL, DynamoDB e SQS LocalStack.

## CI/CD e Kubernetes

CI de PR/main executa typecheck, testes com gates >=80% em statements/branches/functions/lines, build, upload de cobertura, **SonarCloud com quality gate bloqueante**, Docker build, Terraform fmt/validate. Configurar `SONAR_TOKEN`, organização/projeto em `sonar-project.properties`. Deploy ocorre somente após CI bem-sucedido de push main e usa exatamente o SHA testado.

O deploy faz Terraform apply com backend/state exclusivo `oficina/production/terraform.tfstate`, publica imagem imutável no ECR, carrega secret de aplicação do Secrets Manager, aplica Helm atomicamente e verifica rollout. Namespace exclusivo **`oficina-fase4`**, preservando o namespace legado. Plataforma EKS/metrics-server/Datadog vem do repo compartilhado; este serviço não altera recursos da Fase 3. Provisiona tabela PAY_PER_REQUEST com PITR/criptografia, SQS/DLQ e ECR próprios. Helm contém Deployment, Service, probes, requests/limits e HPA 2–4 réplicas.

`service.type` é configurável e usa `LoadBalancer` por padrão para integração HTTP_PROXY pública do API Gateway no Academy, sem VPC Link. No auth Terraform, configurar `production_backend_url=http://<hostname-do-loadbalancer>:3002`; a chamada entre OS e Production pode usar DNS interno `http://oficina-production-service.oficina-fase4.svc.cluster.local:3002`. O Service continua acessível internamente mesmo expondo LoadBalancer.

Configurar Secrets GitHub `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `SONAR_TOKEN`; Variables `TF_STATE_BUCKET`, `EKS_CLUSTER_NAME`, `OS_QUEUE_URL`. Bucket Terraform é pré-requisito compartilhado já provisionado. Após primeiro provisionamento, preencher `oficina/homolog/production/application` por canal seguro com JSON `{"JWT_SECRET":"...","AUTH_CLIENT_LOOKUP_TOKEN":"..."}`; esses valores precisam coincidir com os demais serviços. O deploy inicial sem secret preenchido falha explicitamente e pode ser repetido com novo push/CI após preenchimento.

AWS Academy: confirmar permissões/quota/crédito para DynamoDB, SQS, ECR e EKS antes de provisionar. O deploy injeta as credenciais temporárias da sessão AWS do Environment GitHub `homolog` no Kubernetes Secret sem imprimir valores e reinicia o Deployment para carregá-las; renovar secrets e executar deploy novamente após expiração da sessão. Não depende de acesso IMDS dos pods ou criação de IAM roles. Permissões mínimas necessárias incluem DynamoDB GetItem/Query/Scan/UpdateItem/TransactWriteItems e SQS Receive/Delete/Send. Fora do Learner Lab, substituir credenciais de sessão por identidade de workload com escopo por serviço.

`.github/settings.yml` registra a intenção de proteção de `main`; **não aplica regras automaticamente**. Antes da entrega, aplicar proteção real: PR obrigatório, uma aprovação, check `Build tests quality` obrigatório atualizado, sem force-push/deleção e administradores incluídos; guardar evidência da configuração no GitHub.

## Observabilidade e demonstração

`dd-trace/init` inicia APM antes do Nest. Configurar `DD_SERVICE=oficina-production-service`, `DD_ENV`, `DD_VERSION` e `DD_AGENT_HOST`. Interceptor HTTP emite `oficina.api.request.duration_ms` como **distribution em milissegundos**, via DogStatsD UDP 8125, com tags `env`, `service`, `version`, `method`, `status_code`; respeita `DD_METRICS_ENABLED=false` e falhas de telemetria não interrompem requisições. Helm obtém `DD_AGENT_HOST` de `status.hostIP`. Mensagens propagam `traceparent`, `sagaId`, `correlationId` e `osId`; o worker cria spans `production.command` com esses identificadores e logs JSON de processamento/erro. Datadog Agent recebe logs dos pods. A plataforma deve alertar profundidade/idade de SQS/DLQ, falhas de comandos e duração da Saga.

Falha demonstrável: habilitar **somente em homologação** `ENABLE_DEMO_FAILURES=true`; enviar `ConfirmExecution` com `payload.failStage="ConfirmExecution"` após reservar. Production emite `CommandFailed`; OS envia `CancelExecutionReservation`; ordem termina cancelada e estoque retorna ao saldo anterior. Default `false`; sem habilitação, `failStage` é ignorado. Testes cobrem compensação, mensagem tardia, duplicidade e proibição de rollback após trabalho físico.

Suíte real adicional executada com os três apps e bancos/filas locais: **4/4 cenários de resiliência aprovados**, incluindo falta de estoque, reposição/retry da mesma OS com nova Saga, duplicatas/mensagens tardias e restart do OS enquanto a aprovação estava enfileirada. Evidência em [`docs/resilience-summary.json`](docs/resilience-summary.json). Essa validação não representa deploy AWS nem integração com uma conta real do Mercado Pago.
