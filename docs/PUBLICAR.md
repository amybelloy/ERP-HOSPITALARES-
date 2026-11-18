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
6. Pegue a senha inicial: no serviço `saude-gestao` → **Environment** → variável **SEED_PASSWORD** (clique para revelar).
   Entre com `admin@demo.local` e essa senha. (No Render a senha **não** é `Demo@12345`, que é pública no README.)

## Dar acesso a outras pessoas
1. Entre como administrador → menu **Administração → Usuários e permissões → + Novo usuário**.
2. Informe nome, e-mail, **perfil** (Recepção, Caixa, Faturamento, Financeiro, Fiscal, Médico, Enfermagem,
   Técnico de enfermagem ou Administração) e uma senha inicial (mín. 10 caracteres, com letras e números).
3. Envie à pessoa o link do sistema, o e-mail e a senha inicial por um canal privado.
4. Cada perfil vê apenas as áreas permitidas. As permissões de cada perfil podem ser ajustadas na matriz
   da mesma tela, e um usuário pode ser desativado a qualquer momento (as sessões dele são encerradas).

Recomendado depois de publicar: troque a senha do `admin@demo.local` e **desative os usuários de demonstração**
que não forem usados.

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
