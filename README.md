# CraftSystem

Landing page e serviço local de gerenciamento do servidor Minecraft.

## Desenvolvimento

```bash
npm install
npm run dev
```

## Serviço integrado

```bash
npm run build
npm start
```

O serviço publica a landing compilada e a API do Host Switch. A exportação não depende do estado da instância; antes de restaurar, configure a verificação real conforme o [manual do Host Switch](docs/host-switch.md).

Outros computadores não precisam deste repositório: podem enviar um ZIP comum da pasta do servidor para a opção **Padronizar ZIP**. O CraftSystem gera um pacote v2 verificável e pronto para extração direta no próximo host.

## Verificações

```bash
npm test
npm run build
npm audit
```

O esquema do pacote está documentado em [`docs/host-switch-manifest.schema.json`](docs/host-switch-manifest.schema.json).
