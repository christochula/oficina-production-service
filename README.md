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
| `GET /api/v1/production/internal/inventory/:id?filialId=` | `X-Internal-Token`; identidade/estado da peça na filial explícita, sem ampliar acesso público ao estoque |
| `GET /api/v1/production/orders?filialId=` | JWT; fila filtrada pela propriedade e opcionalmente filial |
| `GET /api/v1/production/orders/:osId` | JWT; administrador, mecânico atribuído ou cliente proprietário |
| `POST /api/v1/production/orders/:osId/assign` | administrador; `{mecanicoId}` |
| `POST /api/v1/production/orders/:osId/diagnosis` | administrador/mecânico atribuído; `{descricao}` |
| `POST /api/v1/production/orders/:osId/start` | administrador/mecânico atribuído; exige `READY` |
| `POST /api/v1/production/orders/:osId/consume` | administrador/mecânico atribuído; `{pecaId,quantidade,operationId?}`; limitado à reserva desta OS |
| `POST /api/v1/production/orders/:osId/complete` | administrador/mecânico atribuído; exige consumo de todas as peças reservadas |
| `PUT /api/v1/production/stock/:pecaId` | administrador; `{filialId,quantity,description?}`; `quantity` é quantidade disponível, preserva reservas/consumo |
| `GET /api/v1/production/health` | público; readiness consulta DynamoDB |
| `GET /api/health/live` | público; liveness do processo |

JWT compartilhado com auth: assinatura **HS256**, issuer `oficina-auth-serverless`, audience `oficina-api`, `exp`, `sub` e `role` obrigatórios. Roles: `ADMINISTRADOR` (alias `ADMIN`), `CONSULTOR_TECNICO`, `MECANICO`, `CLIENTE`. Consultor lê ordens e atribui mecânico; administrador gerencia estoque. Mecânico usa `sub` como `mecanicoId`; cliente usa `client_id` assinado quando presente, ou `sub`, e nunca altera produção. O cliente vinculado a um usuário pode ter `client_id` distinto de `sub`. A posse da OS é verificada novamente a cada retry transacional de escrita, inclusive após uma atribuição concorrente.

Consumo aceita `operationId` UUID opcional. O portal deve criar um UUID para cada intenção de consumo e reutilizá-lo, com a mesma peça e quantidade, se a resposta da requisição se perder. O recibo é gravado na mesma transação do estoque, revisão da ordem e outbox. Repetição autorizada retorna a ordem atual sem consumir ou publicar novamente, inclusive depois de `COMPLETED`; UUID inválido retorna 400 e chave reutilizada com outra peça/quantidade retorna 409. A chave pertence à OS; uma nova operação usa outro UUID. Sem `operationId`, permanece o comportamento legado, sem garantia de deduplicação de requisições HTTP. A fachada OS `PATCH /api/v1/ordens-servico/:id/consumo-peca` encaminha esse campo sem substituí-lo.

Catálogo/estoque para o portal: `/api/v1/production/inventory` (`GET` paginado, `POST` cadastro), `/:id` (`GET`, `PATCH` metadados), `/:id/entrada`, `/:id/ativar`, `/:id/desativar` (`PATCH`). Query `filialId` identifica o saldo da filial; cadastro permite código igual em filiais diferentes e impede duplicidade na mesma filial. Cadastro/entrada usam unidades inteiras; entrada faz incremento atômico sem sobrescrever reservas concorrentes. Código da peça é imutável. O OS expõe a fachada HTTP `/api/v1/estoque` para compatibilidade do portal e mantém todos os dados no Production, sem tabela SQL duplicada. Mecânicos podem consultar estoque, somente administradores alteram.

A listagem aceita `busca` (trecho de código, nome ou descrição, ignorando caixa/acentos), `ativo=true|false`, `filialId`, `pagina` e `porPagina` (1–100). Filtros são aplicados a todo o catálogo antes da paginação; `meta.total` e `totalPaginas` contam somente o resultado filtrado, com zero páginas quando não há correspondência. Ausência de `ativo` inclui ativos e inativos; estoque zero continua sendo um cadastro válido. Ordenação por nome tem desempate determinístico por filial, código e ID. Código+filial identifica a peça para pessoas, enquanto o UUID existente permanece a chave interna. O lookup interno exige filial e retorna o estado ativo inclusive para leitura histórica; os serviços chamadores devem rejeitar peça inativa em novas solicitações/orçamentos. Reserva verifica novamente existência, filial e estado ativo e mantém as condições transacionais autoritativas.

Excesso de consumo retorna HTTP400 com `code=QUANTITY_EXCEEDS_RESERVATION`, `definitive=true`, `pecaId`, `filialId`, `quantidadeSolicitada`, `quantidadeReservada`, `quantidadeConsumida` e `quantidadeRestante`, além de mensagem indicando que nada foi consumido. Quantidade inválida e peça não reservada usam `INVALID_CONSUMPTION_QUANTITY` e `PART_NOT_RESERVED`. O recibo idempotente é conferido antes dessas validações para que repetir uma operação já confirmada permaneça seguro.

## Mensageria, consistência e compensação

Envelope v1: `{messageId,type,version:1,sagaId,osId,filialId,correlationId,occurredAt,traceparent?,payload}`. `INBOX_QUEUE_URL` recebe comandos e `OS_QUEUE_URL` recebe eventos. A fila de Production é standard SQS com entrega pelo menos uma vez; o publisher também aceita destino OS FIFO, preenchendo MessageGroupId=osId e MessageDeduplicationId=messageId. Não existe promessa de entrega exatamente uma vez.

Comandos: `ReserveExecution` com `payload.budget={items:[{description,quantity,unitPriceCents,pecaId?}],totalCents,version}`, `ConfirmExecution`, `CancelExecutionReservation`. Valores em centavos inteiros e total consistente; até 50 itens. Linhas da mesma peça são agregadas antes da reserva. Diagnóstico e mecânico são obrigatórios antes de reservar.

Eventos: `ExecutionReserved`, `ExecutionReady`, `ExecutionCancelled`, `ExecutionStarted`, `ProductionCompleted`, `MechanicAssigned {mecanicoId}`, `DiagnosisRecorded {descricao}`, `PartsConsumed {pecaId,quantidade}`. Falhas de domínio retornam `CommandFailed {commandType,reason}` via outbox, sem mutação parcial. Mensagens inválidas/falhas de infraestrutura não são confirmadas; SQS tenta novamente e encaminha à DLQ após cinco recebimentos.

Falha de estoque em `ReserveExecution` acrescenta `code=INSUFFICIENT_STOCK` e `faltasEstoque:[{pecaId,nome,codigo?,filialId,quantidadeNecessaria,quantidadeDisponivel,quantidadeFaltante,motivo}]`. O motivo distingue `ESTOQUE_INSUFICIENTE`, `PECA_INATIVA` e `PECA_NAO_ENCONTRADA_NA_FILIAL`. A explicação é lida novamente após rejeição transacional por concorrência; não substitui a condição de saldo/ativo no DynamoDB. `reason` e o envelope v1 permanecem compatíveis com consumidores antigos. Reservas novas guardam nome/código como snapshots opcionais de identidade, sem alterar IDs ou a estrutura da tabela.

Uma única `TransactWriteItems` grava alteração da ordem com controle de versão, mutações condicionais de estoque, inbox, marcador permanente do passo `(osId,sagaId,type)` e outbox. Assim, uma peça sem saldo aborta a reserva inteira; duplicatas não reservam nem compensam duas vezes. Cancelamento grava tombstone mesmo sem existir ordem. Reserva/confirmação verificam ausência do tombstone dentro da mesma transação, impedindo reabertura por mensagem tardia.

Outbox persistente usa GSI `pending-index` e lease condicional de 30s; envio SQS vem antes da remoção do índice. Queda após envio pode repetir evento; OS deve deduplicar `messageId`. Inbox e eventos enviados têm TTL de sete dias; marcadores de passos/tombstones não expiram. Leitura individual é consistente; fila por filial usa GSI eventualmente consistente. Consulta administrativa sem filial percorre a tabela paginada: para operação nacional, deve ganhar índice dedicado/paginação de API antes de alto volume.

### Modelo DynamoDB

Tabela exclusiva, chave string `pk`: `ORDER#osId`, `STOCK#filialId#pecaId`, `CODE#filialId#codigo`, `INBOX#messageId`, `STEP#osId#sagaId#type`, `CANCELLED#sagaId`, `OUTBOX#messageId` e `CONSUMPTION#osId#operationId`. O recibo de consumo guarda somente o hash SHA-256 de peça/quantidade, não expira e não aumenta o agregado da ordem. Sua inclusão usa a tabela existente, sem migração. GSI: hash `gsi1pk`, sort `gsi1sk`, projeção ALL; TTL `expiresAt`. Ordens indexadas por `ORDERS#filialId`; outbox por `OUTBOX#PENDING`. Cadastro da peça e marcador de código único são escritos juntos em transação. Proibido reutilizar esta tabela por outro serviço.

## Desenvolvimento e validação

Node 22. Instalar com `npm ci --ignore-scripts`, configurar `.env.example` no ambiente do processo e executar `npm run build && npm start`. O app não carrega `.env` automaticamente; pode usar `node --env-file=.env --require dd-trace/init dist/main.js`. LocalStack requer DynamoDB/SQS, tabela e filas conforme modelo acima; `AWS_ENDPOINT_URL` e credenciais locais `test` atendem os dois SDKs. Compose/BDD de integração vivem no workspace de entrega, fora deste repositório autônomo.

```bash
npm run typecheck
npm run test:cov
npm run build
npm run docs
docker build -t oficina-production-service:local .
```

**Evidência local anterior (registro histórico):** 63 testes aprovados; cobertura global statements/lines/functions 100%, branches 98,48% (7 suítes: domínio, HTTP/JWT, inventário, adaptador DynamoDB, SQS, telemetria e propagação W3C). Resumo medido versionado em [`docs/coverage-summary.json`](docs/coverage-summary.json). O relatório real é gerado em `coverage/lcov-report/index.html` e publicado como artifact `production-coverage` em cada CI. A cobertura inclui controllers, guards, mensageria e persistência; exclui somente bootstrap/wiring, interfaces e DTOs declarativos. Não inclui execução na AWS real; o fluxo entre os três serviços é validado separadamente no BDD integrado com PostgreSQL, DynamoDB e SQS LocalStack.

## CI/CD e Kubernetes

O workflow `Production CI` de PR e push em qualquer branch concentra no check `Build tests quality`: typecheck, testes com gates >=80% em statements/branches/functions/lines, build, upload de cobertura, **SonarCloud com quality gate bloqueante**, Docker build e Terraform fmt/validate. Configurar Repository Secret `SONAR_TOKEN` e Repository Variables `SONAR_PROJECT_KEY`/`SONAR_ORGANIZATION`; ausência de configuração falha o CI. Deploy exige esse check completo bem-sucedido em uma execução CI de push/dispatch do mesmo repositório, branch e SHA, ainda HEAD dessa branch. A integração real com DynamoDB/SQS entre os três serviços também é exercitada pelo BDD do OS Service.

O workflow `Production deploy` separa operações `plan`, `apply` e `deploy`, todas via GitHub Actions. Terraform usa state exclusivo `oficina/production/terraform.tfstate` e provisiona DynamoDB PAY_PER_REQUEST com PITR/criptografia, SQS/DLQ, ECR e referência do secret próprios. `apply` exige um plano previamente revisado, sem deleção/substituição, texto idêntico e fingerprint semântico igual. `deploy` somente lê outputs existentes, publica imagem imutável no ECR, carrega o secret de aplicação, aplica Helm atomicamente e verifica rollout. Namespace exclusivo **`oficina-fase4`**, preservando o legado. Plataforma EKS/metrics-server/Datadog vem do repo compartilhado. Helm contém Deployment, Service, probes, requests/limits e HPA 2–4 réplicas. Procedimento, inputs e fallback por tags estão em [deploy por GitHub Actions](docs/deploy-actions.md).

`service.type` é configurável e usa `LoadBalancer` por padrão para integração HTTP_PROXY pública do API Gateway no Academy, sem VPC Link. No auth Terraform, configurar `production_backend_url=http://<hostname-do-loadbalancer>:3002`; a chamada entre OS e Production pode usar DNS interno `http://oficina-production-service.oficina-fase4.svc.cluster.local:3002`. O Service continua acessível internamente mesmo expondo LoadBalancer.

No Environment GitHub `homolog`, configurar Secrets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`; Variables `TF_STATE_BUCKET`, `EKS_CLUSTER_NAME`, `OS_QUEUE_URL` e, após revisar o plano, `PRODUCTION_APPROVED_PLAN_RUN_ID`. Repository Variable `DEPLOY_SOURCE_REF` identifica a branch de origem das tags operacionais (padrão `feature/aws-mercadopago-test`). Bucket Terraform é pré-requisito compartilhado. Durante a operação `deploy`, o helper Actions preenche a primeira versão do secret de aplicação já criado pelo Terraform com `JWT_SECRET` e `AUTH_CLIENT_LOOKUP_TOKEN` canônicos. `JWT_SECRET_ID` e `AUTH_CLIENT_LOOKUP_SECRET_ID` usam `oficina/fase4/jwt` e `oficina/fase4/auth-client-lookup` por padrão; ambos precisam ter sido inicializados pelo workflow OS. `PRODUCTION_SECRET_ID` (ou `APPLICATION_SECRET_ID`) pode selecionar o secret da aplicação, com fallback no output Terraform `oficina/homolog/production/application`. Valores válidos existentes são preservados; divergências bloqueiam o deploy sem rotação silenciosa.

AWS Academy: confirmar permissões/quota/crédito para DynamoDB, SQS, ECR e EKS antes de provisionar. O deploy injeta as credenciais temporárias da sessão AWS do Environment GitHub `homolog` no Kubernetes Secret sem imprimir valores e reinicia o Deployment para carregá-las; renovar secrets e executar deploy novamente após expiração da sessão. Não depende de acesso IMDS dos pods ou criação de IAM roles. Permissões mínimas necessárias incluem DynamoDB GetItem/Query/Scan/UpdateItem/TransactWriteItems e SQS Receive/Delete/Send. Fora do Learner Lab, substituir credenciais de sessão por identidade de workload com escopo por serviço.

`.github/settings.yml` registra a intenção de proteção de `main`; **não aplica regras automaticamente**. A proteção deve exigir PR, uma aprovação e o check `Build tests quality` obrigatório, sem force-push/deleção e com administradores incluídos; conferir e guardar evidência da configuração no GitHub.

## Observabilidade e demonstração

`dd-trace/init` inicia APM antes do Nest. Configurar `DD_SERVICE=oficina-production-service`, `DD_ENV`, `DD_VERSION` e `DD_AGENT_HOST`. Interceptor HTTP emite `oficina.api.request.duration_ms` como **distribution em milissegundos**, via DogStatsD UDP 8125, com tags `env`, `service`, `version`, `method`, `status_code`; respeita `DD_METRICS_ENABLED=false` e falhas de telemetria não interrompem requisições. Helm obtém `DD_AGENT_HOST` de `status.hostIP`. Mensagens propagam `traceparent`, `sagaId`, `correlationId` e `osId`; o worker cria spans `production.command` com esses identificadores e logs JSON de processamento/erro. Ao persistir qualquer evento na outbox, captura o `traceparent` W3C do span HTTP/consumer ativo e usa o contexto da mensagem recebida como fallback. Docker/Helm configuram injeção/extração `datadog,tracecontext`. Testes com tracer mock validam os dois caminhos sem Datadog externo. Datadog Agent recebe logs dos pods. A plataforma deve alertar profundidade/idade de SQS/DLQ, falhas de comandos e duração da Saga.

Falha demonstrada na homologação: orçamento com peça sem estoque. Production emite `CommandFailed`; OS envia `CancelExecutionReservation` e libera a preparação do orçamento. A OS mantém a aprovação, com preparação `COMPENSATED`, permitindo reposição e nova tentativa com outra Saga. O trabalho reservado é cancelado e as peças são liberadas. A injeção opcional `ENABLE_DEMO_FAILURES` permanece desabilitada na AWS. Testes também cobrem falha após reserva, mensagem tardia, duplicidade e proibição de rollback após trabalho físico.

Suíte real adicional executada com os três apps e bancos/filas locais: **4/4 cenários de resiliência aprovados**, incluindo falta de estoque, reposição/retry da mesma OS com nova Saga, duplicatas/mensagens tardias e restart do OS enquanto a aprovação estava enfileirada. Evidência em [`docs/resilience-summary.json`](docs/resilience-summary.json). Essa validação não representa deploy AWS nem integração com uma conta real do Mercado Pago.

## Evidências publicadas de CI, cobertura e deploy

### Snapshot de 10/11/2026, 21h45 (America/Sao_Paulo)

A **OS #2**, `os06a521bf-0d80-49b5-8dd2-1a1c9c961588`, terminou **ENTREGUE**, com pagamento de **R$175,00** após o reparo. A falta de uma peça em estoque levou à compensação e à preparação `COMPENSATED`. Depois da reposição, o retry usou nova Saga e a preparação chegou a `COMPLETED`; o mecânico iniciou/concluiu o reparo, o Checkout Pro TEST foi aprovado e o OS confirmou a entrega.

- [CI aprovado](https://github.com/christochula/oficina-production-service/actions/runs/42928175814): `Build tests quality` bem-sucedido, incluindo quality gate Sonar, para o SHA `7daa58af1273d952161dc74ec73fe9e20ac8eb31`.
- [Deploy aprovado](https://github.com/christochula/oficina-production-service/actions/runs/42928627925): mesma revisão, imagem imutável, duas réplicas atualizadas/prontas e health HTTP200.
- Cobertura Jest desse código: **66 testes**, statements **100%**, branches **98,53%**, funções **100%**, linhas **100%**. O CI publica o artifact `production-coverage`; esses percentuais são do Jest, não do painel Sonar.
- Na validação de pagamento desse fluxo, a API canônica do provedor confirmou a referência e **175 BRL**, com contas de teste conferidas. O campo **`live_mode=true`** foi preservado como observado. O Billing registrou `billing.payment.checked` com `source=webhook` em **11/11/2026 às 00:43:09.702Z**, e o OS consumiu `PaymentConfirmed` antes da entrega. Identificadores de pagamento e dados de acesso ficam fora deste README.
- Datadog foi validado na UI/API: latência HTTP dos três serviços, seis séries de filas e sete séries de Saga; **p95 com séries dos três serviços**. A amostra observada inclui um trace com OS, Billing e Production, além dos logs correlacionados das etapas da Saga. [Dashboard de homologação](https://app.datadoghq.com/dashboard/u6t-x9c-awx/oficina--operao-e-observabilidade--homolog).
- [Guia para gravar a demonstração](https://github.com/christochula/oficina-api/blob/feature/phase4-distributed/docs/entrega/pronto-para-gravar.md), mantido no repositório OS.

### Histórico de 06/11/2026 — OS #1

Snapshot de 06/11/2026, fonte implantada `ac3d2ee`:

- [CI aprovado](https://github.com/christochula/oficina-production-service/actions/runs/42214602177): check `Build tests quality`, incluindo testes, build, quality gate Sonar obrigatório, imagem Docker e validação Terraform.
- [SonarCloud](https://sonarcloud.io/dashboard?id=christochula-oficina_oficina-production-service): cobertura **99,3%**, linhas 100,0% e branches 98,5%; quality gate aprovado. São métricas Sonar, distintas do resumo Jest local.
- [Relatório de cobertura](https://github.com/christochula/oficina-production-service/actions/runs/42214602177/artifacts/13500604823): artifact `production-coverage` da mesma execução CI.
- [Deploy por GitHub Actions aprovado](https://github.com/christochula/oficina-production-service/actions/runs/42225399746): imagem imutável do SHA `ac3d2ee16f08403c0d734966ce50613442f2b633`, duas réplicas prontas no EKS e health público HTTP200 após o rollout.
- [OpenAPI público para Swagger](https://8phthn792m.execute-api.us-east-1.amazonaws.com/api/v1/production/openapi.json) e [health pelo Gateway](https://8phthn792m.execute-api.us-east-1.amazonaws.com/api/v1/production/health), verificados em 06/11/2026.

A disponibilidade da homologação depende da sessão ativa do AWS Academy; renovar credenciais e fazer o deploy pelo GitHub Actions após a expiração.
