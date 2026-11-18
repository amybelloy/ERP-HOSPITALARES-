# Integrações: Santander (Pix), Getnet (cartão) e NFS-e

Escolhas registradas para este projeto:

1. **Pix:** Santander.
2. **Maquininha de cartão:** Getnet.
3. **Nota fiscal:** as duas opções — emitir a NFS-e automaticamente por integração **e** apenas preparar os dados para emissão em outro sistema.

Cada integração implementa uma interface (`PixProvider`, `CardProvider`, `FiscalProvider`). Trocar de
banco, adquirente ou emissor fiscal = escrever um novo adaptador e registrá-lo em
`backend/src/integrations/index.js`. Nenhuma regra de quitação depende de um provedor específico.

Estado de cada integração (configurada ou com variáveis faltando) aparece em
**Configurações e integrações** e em `GET /api/integrations`. Nenhum segredo é exibido.

---

## 1. Pix — Santander (`SantanderPixProvider`)

O Santander oferece a API Pix no padrão do Banco Central (endpoints `cob`, `pix`, `devolução`,
`webhook`), autenticada com **OAuth2 client credentials + mTLS** (certificado de cliente).

**O que está implementado**

- Obtenção e cache do token OAuth2 sobre mTLS.
- `PUT /cob/{txid}` — cobrança imediata com valor fixo, expiração e devedor (nome/CPF); retorna `pixCopiaECola`/`location` para o QR dinâmico.
- `GET /cob/{txid}` — consulta de status (`ATIVA`, `CONCLUIDA`, `REMOVIDA_*`) e dos Pix recebidos (`endToEndId`, valor, horário, devoluções).
- `PATCH /cob/{txid}` — remoção da cobrança (cancelamento antes do pagamento; o sistema reconsulta antes).
- `PUT /pix/{e2eid}/devolucao/{id}` — devolução (estorno); a conta só é atualizada quando o banco informar `DEVOLVIDO`.
- `GET /pix?inicio&fim` — importação paginada para a conciliação.
- Webhook: `POST /api/webhooks/pix/SANTANDER_PIX/{PIX_WEBHOOK_SECRET}` (aceita também o sufixo `/pix` que o padrão BACEN acrescenta).

**O que falta configurar** (`.env`):

| Variável | Conteúdo |
|---|---|
| `PIX_PROVIDER=SANTANDER_PIX` | ativa o adaptador |
| `SANTANDER_PIX_BASE_URL`, `SANTANDER_PIX_TOKEN_URL` | URLs do ambiente (sandbox/produção) — **confirmar no portal do desenvolvedor Santander** |
| `SANTANDER_CLIENT_ID`, `SANTANDER_CLIENT_SECRET` | credenciais da aplicação |
| `SANTANDER_CERT_PATH`, `SANTANDER_KEY_PATH`, `SANTANDER_CERT_PASSPHRASE` | certificado mTLS (arquivos no servidor, fora do repositório) |
| `SANTANDER_PIX_KEY` | chave Pix recebedora do hospital |
| `PIX_WEBHOOK_SECRET` | segredo aleatório longo que compõe a URL do webhook |
| `PIX_WEBHOOK_REQUIRE_MTLS_HEADER=true` | exige que o proxy tenha validado o certificado do banco (ver nginx em ARQUITETURA.md) |

**Cadastro do webhook no banco**: `PUT /webhook/{chave}` com
`{"webhookUrl": "https://SEU_DOMINIO/api/webhooks/pix/SANTANDER_PIX/<PIX_WEBHOOK_SECRET>"}`
(pode ser feito pelo portal ou por chamada à API).

**Homologação sugerida**: criar cobrança de R$ 0,01 no sandbox → pagar → verificar webhook + consulta →
devolver → conciliar o período. Confirme também limites de taxa (rate limit) e formato exato dos erros.

---

## 1b. Boleto — Santander (`SantanderBoletoProvider`)

- Registro do boleto em nome do paciente (pagador), com nosso número, vencimento e valor; o banco devolve
  código de barras e linha digitável.
- Liquidação confirmada por **webhook autenticado + consulta ao banco** (mesma regra do Pix), em
  `POST /api/webhooks/boleto/SANTANDER_BOLETO/{BOLETO_WEBHOOK_SECRET}`; "Consultar status" reconsulta.
- Cancelamento = baixa no banco. Estorno de boleto pago é feito por devolução manual (TED/Pix) auditada.
- Variáveis: `BOLETO_PROVIDER=SANTANDER_BOLETO`, `SANTANDER_BOLETO_BASE_URL`, `SANTANDER_BOLETO_TOKEN_URL`,
  `SANTANDER_BOLETO_WORKSPACE`, `SANTANDER_BOLETO_BENEFICIARIO`, `BOLETO_WEBHOOK_SECRET` (+ credenciais e certificado do Santander).
  Os caminhos HTTP estão marcados como pontos de ajuste — confirme na API de cobrança contratada.
- Em demonstração, o código de barras e a linha digitável seguem o padrão FEBRABAN (DV módulo 11 e 10,
  fator de vencimento com o reinício de 22/02/2025), mas o boleto não é registrado em banco algum.

---

## 2. Cartão — Getnet (`GetnetProvider`)

A Getnet possui mais de um produto para captura presencial; a forma de integração depende do contrato:

| Produto | Como integra | Situação no projeto |
|---|---|---|
| TEF (pinpad no computador do caixa) | gerenciador TEF homologado no posto de trabalho | requer agente local; o adaptador recebe o resultado via callback |
| POS Android "pagamento integrado" | app no terminal chamado por deeplink/SDK | requer app no POS; resultado via callback |
| API que envia cobrança a terminal cadastrado | chamadas HTTP do servidor | **modelo implementado** no adaptador |

**O que está implementado**: OAuth2, envio da transação ao terminal (valor, crédito/débito, parcelas,
referência), consulta, cancelamento/estorno e callback assinado (HMAC-SHA256) em
`POST /api/webhooks/card/GETNET`. Antes de confirmar, o sistema **reconsulta** a transação.
Os caminhos HTTP e o mapeamento de status estão marcados como **pontos de ajuste** — devem ser
alinhados à documentação entregue pela Getnet na contratação/homologação.

**Variáveis**: `CARD_PROVIDER=GETNET`, `GETNET_BASE_URL`, `GETNET_CLIENT_ID`, `GETNET_CLIENT_SECRET`,
`GETNET_SELLER_ID`, `GETNET_TERMINAL_ID`, `CARD_CALLBACK_SECRET`.

**Sem integração**: o caixa usa "Registrar manualmente", informa NSU/autorização do comprovante do
terminal e o pagamento fica **AGUARDANDO_CONFERÊNCIA** até outro usuário autorizado conferir com o
relatório da maquininha. Foto de comprovante não é aceita como confirmação única.

---

## 3. NFS-e — emissão automática **e** exportação

### 3a. Emissão por integração — NFS-e Nacional (`NfseNacionalProvider`)

Para municípios aderentes ao padrão nacional (Sefin Nacional / ADN):

- Geração da **DPS** (XML) a partir de um *snapshot* de prestador, tomador e serviço (`fiscal/dps.js`).
- Envio `POST /nfse` (XML assinado, GZip + Base64) com mTLS usando o certificado **A1** do prestador.
- Consulta `GET /nfse/{chaveAcesso}`, cancelamento por evento `POST /nfse/{chave}/eventos`.
- Armazena número, código de verificação, chave de acesso, protocolo, XML e link oficial quando retornados.
- Falha de comunicação → `FALHA_COMUNICACAO`; o reenvio usa o **mesmo número de DPS** (idempotente no ambiente nacional).

**Pendências para produção**

| Item | Observação |
|---|---|
| `FISCAL_PROVIDER=NFSE_NACIONAL`, `NFSE_NACIONAL_BASE_URL`, `NFSE_AMBIENTE` | produção restrita (2) para homologar |
| `NFSE_CERT_PATH`, `NFSE_CERT_PASSPHRASE` | certificado A1 (PFX) do CNPJ prestador, somente no servidor |
| Assinatura XML-DSig | registrar a função com `registry.fiscal.NFSE_NACIONAL.setSigner(fn)` (ex.: usando `xml-crypto`) |
| Leiaute | conferir o leiaute vigente da DPS e os códigos de tributação nacional/NBS dos procedimentos |
| Dados da instituição | CNPJ, inscrição municipal e código IBGE em *Configurações* |

Se o município **não** aderiu ao padrão nacional, crie um adaptador para o webservice municipal (ou para
um integrador fiscal contratado) implementando `FiscalProvider` — o restante do sistema não muda.

### 3b. Apenas preparar os dados (`EXPORTACAO`)

Na tela fiscal, "Preparar p/ outro sistema" gera o documento em modo exportação: o usuário confere os
dados, baixa a **DPS em XML (não assinada)** ou JSON e emite no sistema que já utiliza. Depois registra
o número/código de verificação em "Registrar emissão externa" (status `EMITIDA_EXTERNAMENTE`).

O modo padrão é definido em *Configurações → Política fiscal*, e ambos ficam disponíveis por conta.

### Demonstração

Sem integração configurada, a emissão roda no `DemoFiscalProvider`: documentos com `is_demo = true`,
número `DEMO-…`, faixas "DEMONSTRAÇÃO — sem validade fiscal" em todas as telas, nada é transmitido.
A aba *Simulação* permite forçar resultado **pendente** ou **rejeitado** e falha de comunicação.

---

## Regras que valem para qualquer provedor

1. Confirmação só com fonte confiável (webhook autenticado **+ consulta**, terminal, ou conferência por 2º usuário).
2. Idempotência por identificador do provedor (endToEndId, NSU, id de devolução).
3. Pagamento sempre resolvido pela cobrança (`txid`/id da transação) registrada — nunca por dados do payload.
4. Erro de comunicação nunca confirma nada; eventos com erro são reprocessados.
5. Estornos só alteram a conta quando o provedor confirma a devolução/cancelamento.
6. Status fiscal e financeiro são independentes; estorno após nota emitida gera alerta para o fiscal.
