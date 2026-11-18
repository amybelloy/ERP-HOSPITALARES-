# Deixar o sistema sempre no ar (publicação)

O ambiente de desenvolvimento usado para construir o sistema é temporário: ele é desligado após um
período sem uso e, com ele, o servidor e o banco de dados. Para ter um endereço fixo na internet, o
sistema precisa rodar em um serviço de hospedagem.

## Opção recomendada para demonstração: Render (plano gratuito)

O repositório já tem o arquivo `render.yaml`, que cria automaticamente o banco PostgreSQL e o sistema.

1. Crie uma conta em https://render.com (pode entrar com a conta do GitHub).
2. No painel do Render: **New → Blueprint**.
3. Conecte o GitHub e escolha o repositório **ERP-HOSPITALARES-**.
   - Se o pull request ainda não foi mesclado na `main`, selecione a branch `ccr-e617eb86-ggtqqb`.
4. Confirme (**Apply**). O Render cria o banco `saude-gestao-db` e o serviço `saude-gestao`.
5. Aguarde a primeira publicação (alguns minutos). O endereço aparece no topo do serviço,
   no formato `https://saude-gestao-xxxx.onrender.com`.
6. Entre com `admin@demo.local` / `Demo@12345` (demais usuários no README).

Na primeira subida, o sistema cria as tabelas e os dados fictícios sozinho (`SEED_ON_START=true`).
A cada novo commit na branch escolhida, o Render publica a nova versão automaticamente.

### Limites do plano gratuito do Render
- O sistema **"dorme" após ~15 minutos sem acesso**; o primeiro acesso seguinte demora cerca de 1 minuto para acordar.
- O banco gratuito **expira após cerca de 30 dias** (o Render avisa por e-mail); depois é preciso recriá-lo ou passar para um plano pago.
- Para ficar **sempre ligado e sem expirar**, use os planos pagos do Render (web "Starter" e banco "Basic") — confira os valores atuais no site.

## Antes de usar com pacientes reais (produção)
O endereço acima é uma **demonstração** (provedores simulados e dados fictícios). Para uso real:
- `DEMO_MODE=false`, `SEED_ON_START=false` e troca de todas as senhas de demonstração;
- hospedagem paga com backup automático do banco, domínio próprio com HTTPS;
- credenciais e homologação do Santander, Getnet e NFS-e (ver `docs/INTEGRACOES.md`);
- adequação à LGPD (dados de saúde), incluindo contrato com o provedor de hospedagem.

## Alternativas
Railway, Fly.io ou um servidor próprio (VPS) com Docker também funcionam: use `docker compose up -d`
e defina as variáveis do `.env.example`.
