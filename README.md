# Saúde Gestão — ERP hospitalar (atendimento, conta, recebimento, quitação automática e NFS-e)

Aplicação web de gestão hospitalar com módulos administrativos integrados. A identidade visual e o
código são próprios (inspirados nos *fluxos* de sistemas como o SOUL MV, sem copiar telas ou código).

O foco é a cadeia **paciente → atendimento → conta → recebimento → quitação → fiscal → conciliação**:

```
Paciente (prontuário único) ──► Atendimento (n por paciente) ──► Conta própria ──► Itens (procedimentos)
                                                                       │
                     Recebimento: Pix (Santander) · Cartão (Getnet) · Dinheiro · Outros
                                                                       │
     confirmação confiável (webhook autenticado + CONSULTA ao provedor | terminal | conferência por 2º usuário)
                                                                       │
                     QUITAÇÃO AUTOMÁTICA (status derivado, idempotente, auditável)
                                                                       │
                ┌──────────────────────────────┬───────────────────────┴──────────────┐
          NFS-e (status fiscal separado)   Comprovante interno        Conciliação bancária
```

> **Ambiente de demonstração.** Com `DEMO_MODE=true` (padrão em desenvolvimento) os provedores de Pix,
> cartão e NFS-e são **simulados** e claramente identificados como DEMONSTRAÇÃO. Nenhum dinheiro é
> movimentado e nenhuma nota oficial é emitida. As integrações reais (Santander, Getnet, NFS-e Nacional)
> estão implementadas como adaptadores e são ativadas por variáveis de ambiente — veja
> [docs/INTEGRACOES.md](docs/INTEGRACOES.md).

## Tecnologias

| Camada | Tecnologia |
|---|---|
| Frontend | HTML5, CSS3 e JavaScript (ES modules, sem build), servido pelo próprio backend |
| Backend | Node.js 20+ com Express 5, APIs REST, webhooks |
| Banco | PostgreSQL 16 (migrações SQL versionadas) |
| Testes | `node:test` + `supertest` contra PostgreSQL real |
| Execução | Docker / Docker Compose |

Dependências de runtime: `express`, `pg`, `bcryptjs`, `helmet`, `express-rate-limit`, `cookie-parser`, `qrcode`.

## Estrutura de pastas

```
├── backend/
│   ├── src/
│   │   ├── app.js / server.js / config.js
│   │   ├── db/            pool + transações, migrate.js, seed.js (dados fictícios)
│   │   ├── lib/           money (centavos), validate, docs (CPF/CNPJ), csv, brcode (Pix), permissions, errors
│   │   ├── middleware/    auth (sessão, RBAC, CSRF)
│   │   ├── services/      regras de negócio (settlement, payment, webhook, fiscal, reconciliation, ...)
│   │   ├── integrations/  adaptadores desacoplados
│   │   │   ├── pix/       PixProvider (interface), DemoPixProvider, SantanderPixProvider
│   │   │   ├── card/      CardProvider (interface), DemoCardProvider, GetnetProvider
│   │   │   └── fiscal/    FiscalProvider (interface), DemoFiscalProvider, NfseNacionalProvider, dps.js
│   │   └── routes/        api.js (REST autenticada), webhooks.js (público, autenticado por segredo/assinatura)
│   ├── tests/             testes automatizados (cenários obrigatórios + extras)
│   └── Dockerfile
├── frontend/
│   ├── index.html
│   ├── css/app.css
│   └── js/                app.js (roteador/shell), api.js, ui.js, components.js, payments.js, pages/*.js
├── database/migrations/   001_schema.sql
├── docs/                  ARQUITETURA.md, INTEGRACOES.md
├── scripts/               backup.sh, restore.sh
├── docker-compose.yml
└── .env.example
```

## Como executar

### Opção A — Docker Compose

```bash
cp .env.example .env              # ajuste se necessário
docker compose up --build -d      # sobe PostgreSQL + aplicação (migrações automáticas)
docker compose run --rm seed      # cria perfis, usuários e dados fictícios
# abra http://localhost:3000
```

### Opção B — Local

Requisitos: Node.js 20+ e PostgreSQL 14+ (usa a extensão `pg_trgm`, incluída no PostgreSQL padrão).

```bash
createuser -s hospital && psql -c "ALTER USER hospital PASSWORD 'hospital'"   # ou use seu usuário
createdb -O hospital hospital_dev
cd backend
npm install
export DATABASE_URL=postgres://hospital:hospital@localhost:5432/hospital_dev
npm run setup          # migrações + seed (usuários e dados fictícios)
npm start              # http://localhost:3000  (frontend e API no mesmo servidor)
```

### Usuários de demonstração

Senha de todos: `Demo@12345` (altere com `SEED_PASSWORD` antes do seed).

| E-mail | Perfil | O que pode fazer |
|---|---|---|
| `recepcao@demo.local` | Recepção | pacientes, agenda, abrir atendimento, lançar procedimento, iniciar recebimento |
| `caixa@demo.local` | Caixa | receber, conferir pagamentos manuais de outros usuários, conferir conta |
| `faturamento@demo.local` | Faturamento | ajustes de preço/desconto, cancelar itens, fechar contas |
| `financeiro@demo.local` | Financeiro | conferir, estornar, reatribuir pagamentos, conciliação, relatórios/CSV, auditoria |
| `fiscal@demo.local` | Fiscal | preparar/emitir/cancelar NFS-e |
| `admin@demo.local` | Administração | tudo, inclusive usuários, permissões e integrações |

### Roteiro de demonstração (paciente particular, ecocardiograma de R$ 500,00)

1. Entre como **recepcao**. Em *Cadastro de pacientes* abra **Paciente de Demonstração** → aba *Histórico*:
   atendimentos de 25/07, 25/08 e 25/09 (quitados) e 01/10 (pendente), todos no mesmo prontuário.
2. Abra a conta do atendimento de 01/10: *Ecocardiograma transesofágico — R$ 500,00*, recebido R$ 0,00,
   saldo R$ 500,00, **Pendente**.
3. Clique **Receber** → Pix → **Iniciar recebimento**: QR Code dinâmico + Pix Copia e Cola (demo).
4. Clique **Simular pagamento Pix pelo pagador**. O "banco simulado" envia um webhook **assinado**; o
   sistema valida, **reconsulta a cobrança** e só então confirma. A conta passa a **Quitada**, saldo
   R$ 0,00, com data/hora e origem da confirmação em *Consultar quitação*.
5. A conta é organizada em **3 etapas**, como no fluxo do SOUL MV:
   **1 · Lançamento da conta** (cabeçalho do atendimento e itens lançados: grupo, procedimento, qtde, setor,
   prestador, valor; "Fecha conta?"), **2 · Dados da conta / Quitação** (seleção entre as contas do paciente,
   totais, pagamentos e histórico da quitação) e **3 · Nota fiscal** (dados de emissão, CNAE, natureza do
   serviço, impostos — ISS, IR, IBS, CBS — e **em nome de quem sai a nota**: o paciente ou outra pessoa/empresa,
   com CPF/CNPJ, endereço e e-mail editáveis antes da emissão).
6. Teste também: cartão via terminal (aprovar/negar), dinheiro (fica *aguardando conferência* até outro
   usuário, ex. **caixa** ou **financeiro**, conferir), pagamento parcial, estorno (como **financeiro**),
   emissão fiscal (como **fiscal**, inclusive pendente/rejeitada na aba *Simulação*), conciliação
   (importar → conciliar) e falhas de comunicação (*Configurações* → simulação de falhas, como **admin**).

## Testes

```bash
createdb -O hospital hospital_test
cd backend
TEST_DATABASE_URL=postgres://hospital:hospital@localhost:5432/hospital_test npm test
```

O banco de teste é **recriado** a cada arquivo de teste. Cobertura dos cenários obrigatórios:

| # | Cenário | Arquivo |
|---|---|---|
| 1 | Cadastro de paciente novo (+ validação, CPF duplicado, possível duplicidade) | `01_cadastro_atendimento` |
| 2 | Pesquisa por nome, CPF, código e prontuário (+ mascaramento LGPD) | `01_…` |
| 3 | Múltiplos atendimentos, mesmo prontuário, contas independentes | `01_…` |
| 4 | Lançamento de exame de R$ 500,00 (+ ajuste de preço exige permissão) | `01_…` |
| 5 | Pix integral confirmado (+ webhook com assinatura inválida, + payload forjado) | `02_pagamentos_quitacao` |
| 6 | Cartão integral confirmado (terminal e manual com conferência) | `02_…` |
| 7 | Pagamento parcial e pagamento dividido | `02_…` |
| 8 | Pagamento rejeitado (cartão negado, conferência rejeitada) | `02_…` |
| 9 | Notificação recebida duas vezes / concorrente | `02_…` |
| 10 | Pagamento associado à conta errada → reatribuição auditável (+ Pix com valor divergente) | `02_…` |
| 11 | Estorno parcial e total (Pix e dinheiro) | `02_…` |
| 12 | Emissão fiscal pendente | `03_fiscal_conciliacao` |
| 13 | Rejeição da emissão fiscal | `03_…` |
| 14 | Falha de comunicação com o banco (criação e consulta) + reprocessamento | `02_…` |
| 15 | Acesso sem permissão / sem sessão / sem cabeçalho CSRF / autoconferência | `01_…` |

Também há testes de conciliação (API e CSV), relatórios CSV, comprovante, modo exportação fiscal,
alerta fiscal após estorno, bloqueios de exclusão no banco e unidades (dinheiro, CPF/CNPJ, BR Code).
Nenhum cenário marca uma conta como quitada indevidamente.

## Segurança e LGPD (resumo)

- Senhas com bcrypt; bloqueio após tentativas inválidas; rate limit no login.
- Sessão em cookie `httpOnly` + `SameSite=Strict` (+ `Secure` em produção), token guardado só como hash;
  expiração por inatividade e absoluta; logout revoga a sessão; troca de senha/perfil revoga sessões.
- CSRF: cabeçalho obrigatório em requisições que alteram estado. CSP estrita (sem scripts/estilos inline), Helmet.
- RBAC por permissão em **todas** as rotas; segregação de funções na conferência de pagamentos manuais.
- Minimização: CPF/contato mascarados para perfis sem `patients.view_sensitive`; consulta à ficha do paciente é auditada.
- Auditoria imutável (gatilhos no banco) de logins, consultas sensíveis, alterações cadastrais e todas as operações financeiras/fiscais.
- Credenciais, certificados e tokens apenas em variáveis de ambiente no servidor; nada sensível no frontend.
- Backups: `scripts/backup.sh` / `restore.sh`. Use apenas dados fictícios fora de produção.

Detalhes em [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

## Antes de usar em um hospital de verdade

Este projeto entrega a base funcional e a arquitetura. Para produção ainda são necessários:

- **Contratos e credenciais** com Santander (API Pix), Getnet (produto de captura presencial) e acesso à
  NFS-e (município aderente ao padrão nacional / certificado A1), seguidos de **homologação** de cada integração.
- Assinatura XML-DSig da DPS (ponto de extensão `setSigner` no adaptador NFS-e Nacional).
- HTTPS/TLS no proxy reverso, mTLS do webhook do banco, segredos em cofre (Vault/Secrets Manager).
- Validação fiscal/contábil (regras de ISS do município, retenções) e jurídica (LGPD: RIPD, base legal, retenção).
- Testes de carga, pentest, monitoramento e rotina de backup testada.
- Faturamento de convênios (TISS) e prontuário clínico estão fora do escopo desta versão (o "prontuário"
  aqui é o registro administrativo do paciente e seu histórico de atendimentos).
