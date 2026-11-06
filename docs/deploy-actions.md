# Provisionamento e deploy por GitHub Actions

Todas as alterações na AWS deste procedimento são executadas pelo workflow `Production deploy` (`.github/workflows/deploy.yml`). O CI `Production CI` deve estar verde para o SHA completo publicado na branch de origem. O gate verifica HEAD atual, repositório, branch, SHA e o job `Build tests quality` na execução CI mais recente de push/dispatch; não aceita jobs pulados, CI de fork nem combinação de resultados de runs diferentes. O job de qualidade inclui SonarCloud bloqueante.

O workflow separa três operações:

| Operação | Efeito |
| --- | --- |
| `plan` | Gera plano de infraestrutura e publica apenas texto redigido pelo Terraform e metadata/fingerprint sem valores sensíveis |
| `apply` | Replaneja, bloqueia deleção/substituição, exige revisão registrada e aplica somente se texto e fingerprint continuarem iguais |
| `deploy` | Lê os outputs do state existente, publica a imagem do SHA testado no ECR e executa Helm no namespace `oficina-fase4` |

O deploy automático após CI de push na `main` executa somente `deploy`; o provisionamento inicial precisa ser planejado e aplicado antes. O SHA da imagem nunca é derivado de uma branch móvel após o gate. A tag ECR usa `SHA-run_id-run_attempt`, compatível com repositório imutável e novas tentativas.

## Configuração

No repositório: Secret `SONAR_TOKEN`; Variables `SONAR_PROJECT_KEY`, `SONAR_ORGANIZATION`, `DEPLOY_SOURCE_REF`. A última vale para tags operacionais e usa `feature/aws-mercadopago-test` por padrão.

No Environment `homolog`: Secrets temporários da AWS Academy `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`; Variables `TF_STATE_BUCKET`, `EKS_CLUSTER_NAME`, `OS_QUEUE_URL`. Depois de revisar um plano bem-sucedido, definir `PRODUCTION_APPROVED_PLAN_RUN_ID` com o ID dessa execução. Configurar restrições de refs e revisores do Environment conforme a política do repositório, preservando a proteção de `main`.

O bucket Terraform deve existir, com acesso privado, versionamento e criptografia. A chave exclusiva é `oficina/production/terraform.tfstate`. A infraestrutura da plataforma EKS é mantida no seu próprio repositório/state. O serviço não cria roles IAM e usa as credenciais temporárias do Environment; elas precisam ser renovadas quando a sessão Academy expirar.

## Execução manual

Selecionar a branch revisada no formulário `Run workflow` e informar `target_ref`, o SHA completo em `target_sha` e `operation=plan`. Os valores precisam corresponder à branch selecionada e ao seu HEAD atual. A mesma operação pela CLI do GitHub:

```bash
REF=feature/aws-mercadopago-test
SHA="$(git rev-parse HEAD)" # HEAD local precisa ser o mesmo publicado nessa branch
gh workflow run deploy.yml --ref "$REF" -f target_ref="$REF" -f target_sha="$SHA" -f operation=plan
```

Revisar recursos, custo, conta/role mostrados na execução e o artifact `production-plan-<SHA>-<RUN_ID>`. Ele contém somente `production-plan.txt` (`terraform show -no-color`) e `production-plan-review.json` (identidade da revisão e SHA256 semântico). Valores sensíveis entram no hash, mas não são emitidos pelo helper. Plano binário, state e JSON bruto de Terraform ficam fora dos artifacts.

Depois da revisão, registrar o ID aprovado e solicitar apply do mesmo SHA:

```bash
gh variable set PRODUCTION_APPROVED_PLAN_RUN_ID --env homolog --body "$PLAN_RUN_ID"
gh workflow run deploy.yml --ref "$REF" -f target_ref="$REF" -f target_sha="$SHA" -f operation=apply
```

O apply confirma que a execução aprovada pertence a este repositório/workflow/SHA e ainda tem o artifact esperado. Uma mudança no texto, nos valores sensíveis, nos outputs ou nas ações do plano exige novo plan/revisão. Qualquer deleção ou substituição é bloqueada. O binário aplicado é o plano salvo nessa execução, removido do runner ao terminar. Para repetir um plan, criar uma nova execução; artifacts de uma revisão existente não são sobrescritos.

Após provisionar, disponibilizar a fila de eventos OS em `OS_QUEUE_URL` e inicializar os secrets canônicos compartilhados pelo workflow OS. A operação `deploy` executa `configure-runtime-secrets.mjs` antes de publicar a imagem e antes de ler o secret da aplicação para o Kubernetes. O helper exige metadata Production já criada pelo Terraform e preenche apenas sua primeira versão com `JWT_SECRET` e `AUTH_CLIENT_LOOKUP_TOKEN` canônicos; não cria metadata Production fora do state, não rotaciona valores existentes e falha se houver divergência.

Variables opcionais `JWT_SECRET_ID` e `AUTH_CLIENT_LOOKUP_SECRET_ID` usam `oficina/fase4/jwt` e `oficina/fase4/auth-client-lookup` por padrão. `PRODUCTION_SECRET_ID` ou `APPLICATION_SECRET_ID` pode selecionar o secret da aplicação; sem override, usa o output Terraform `oficina/homolog/production/application`. O mesmo ID é usado para inicialização e leitura posterior. Apenas a operação `deploy` executa esse bootstrap de valores; `plan`/`apply` permanecem limitadas à infraestrutura Terraform. Então executar:

```bash
gh workflow run deploy.yml --ref "$REF" -f target_ref="$REF" -f target_sha="$SHA" -f operation=deploy
```

O deploy instala kubectl no patch estável do minor do cluster, atualiza o Secret Kubernetes sem imprimir seus valores e usa Helm `--atomic --wait`. O Service público retorna o hostname necessário ao API Gateway; a porta é `3002`.

## Fallback sem merge na main

Se o GitHub ainda não aceitar dispatch da versão do workflow na feature, usar uma tag operacional apontando ao mesmo SHA revisado. Essa publicação também dispara exclusivamente GitHub Actions:

| Tag | Operação |
| --- | --- |
| `phase4/production-plan-<identificador-unico>` | plan |
| `phase4/production-apply-<identificador-unico>` | apply com `PRODUCTION_APPROVED_PLAN_RUN_ID` já revisado |
| `phase4/production-deploy-<identificador-unico>` | deploy |

A Repository Variable `DEPLOY_SOURCE_REF` fornece a branch de origem; o commit da tag deve continuar HEAD dessa branch, com CI verde. O gate é o mesmo do dispatch. O fluxo não muda a branch padrão nem contorna a política de PR/merge da `main`.
