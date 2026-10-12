# Host Switch

O Host Switch cria um pacote versionado e verificável da instalação Minecraft e o restaura localmente no outro computador. Ele não transfere arquivos pela rede, não inicia o servidor e não garante exclusividade distribuída entre os hosts.

## Arquitetura e segurança

- A landing Vite usa a API Node em `/api/host-switch`.
- Toda a API exige `X-Host-Switch-Token`. Na primeira inicialização, um token aleatório é salvo em `.host-switch/access-token` com permissão restrita; prefira definir `HOST_SWITCH_TOKEN` em produção.
- Uma única exportação/restauração pode alterar dados por vez. Uploads têm limite padrão de 20 GiB (`HOST_SWITCH_MAX_UPLOAD_BYTES`).
- O diretório padrão é resolvido independentemente do diretório de execução como `../server`; altere-o com `HOST_SWITCH_SERVER_ROOT`.
- Exportações copiam para um temporário, verificam se cada fonte não mudou, calculam SHA-256, criam o ZIP em `.partial`, reabrem e verificam todo o pacote e só então publicam o nome definitivo.
- Importações rejeitam caminhos absolutos, `..`, barras invertidas, links simbólicos, nomes reservados/ilegais do Windows, duplicatas sem diferença de caixa, arquivos não declarados, tamanhos e hashes divergentes.
- A restauração extrai e revalida em um diretório temporário no mesmo volume. O destino existente é renomeado para backup antes da troca. Uma falha na troca restaura o backup.
- SHA-256 dentro do mesmo ZIP detecta corrupção, mas não autentica o autor. Para resistência a adulteração intencional, o formato precisará futuramente de assinatura digital com chave mantida fora do pacote.

## Estado real da instância

Nenhuma operação destrutiva confia na ausência de resposta da interface. Sem um verificador configurado, o estado é `unknown` e exportar/restaurar é bloqueado.

Para MCSManager, configure as quatro variáveis abaixo. A integração consulta `GET /api/instance`, envia a chave no cabeçalho `x-request-api-key`, considera apenas `data.status === 0` como parado e trata estados de execução/transição como ligados:

```text
HOST_SWITCH_MCS_URL=http://127.0.0.1:23333
HOST_SWITCH_MCS_API_KEY=<defina fora do repositório>
HOST_SWITCH_MCS_DAEMON_ID=<id do daemon>
HOST_SWITCH_MCS_INSTANCE_ID=<uuid da instância>
```

Se a sua versão do MCSManager tiver contrato diferente, use um verificador local sem shell:

```text
HOST_SWITCH_STATUS_COMMAND=/caminho/absoluto/verificar-instancia
HOST_SWITCH_STATUS_ARGS=["--instance","identificador"]
```

O programa deve terminar com código `0` somente quando confirmar que a instância está parada, `10` quando estiver ligada e qualquer outro código quando não puder confirmar. Os argumentos são um array JSON; nada enviado pelo navegador é executado.

## Executar no Linux Mint

1. Pare a instância normalmente pelo MCSManager e aguarde o estado parado.
2. Na raiz do CraftSystem, execute `npm install`, `npm run build` e configure o verificador acima.
3. Inicie com `npm start`. O padrão é `127.0.0.1:4173`; use `HOST` e `PORT` se necessário.
4. Leia o token em `.host-switch/access-token`, abra a landing, vá a **Host Switch**, cole o token e consulte o estado.
5. Clique em **Preparar exportação**. Só baixe o pacote após aparecer **Pronto para download**.
6. Copie o ZIP manualmente para o Windows. Não apague nem inicie novamente a origem até a validação do destino terminar.

## Importar no Windows

Instale uma versão suportada do Node.js, copie este projeto (ou ao menos `bin`, `server`, `package.json` e `package-lock.json`) para o PC e execute `npm ci --omit=dev` no próprio Windows. No PowerShell, primeiro valide sem escrever no servidor:

```powershell
node .\bin\host-switch.js validate C:\Transfer\TechRevolution-migration.zip D:\Minecraft\server
```

Revise `blockers` e `warnings`. Configure o MCSManager ou o comando de estado no ambiente do processo. Pare a instância e, sabendo que todo destino existente será movido para backup, execute:

```powershell
node .\bin\host-switch.js import C:\Transfer\TechRevolution-migration.zip D:\Minecraft\server RESTAURAR
```

O argumento literal `RESTAURAR` é obrigatório. O relatório informa o caminho do backup. O importador não baixa binários, não executa conteúdo do pacote e não inicia o servidor.

Também é possível executar a API/landing no Windows, definir `HOST_SWITCH_SERVER_ROOT=D:\Minecraft\server`, enviar o ZIP, revisar a validação e digitar `RESTAURAR` na interface.

## Política de arquivos

Incluídos: mundos e dimensões encontrados (não apenas nomes convencionais), dados de jogadores, `mods`, `plugins`, KubeJS, configurações, listas de acesso, scripts, bibliotecas e binários pertencentes à instalação, incluindo arquivos ocultos relevantes.

Excluídos: `logs`, `crash-reports`, `debug`, `backups`, `manual-backups`, `.mixin.out`, caches conhecidos, arquivos `.log`, `.tmp`, `.lock`, `.pid` e nomes que indiquem senha, token, credencial ou segredo. O manifesto registra exclusões e caminhos de topo inesperados. Um possível segredo é excluído com aviso para revisão manual; não é descartado silenciosamente do relatório.

Na instalação inspecionada durante a implementação foi detectado Minecraft **1.19.2** e Forge **43.5.2**. Não foi detectado Arclight 1.20.1. O sistema sempre usa o que conseguir provar na instalação e grava `null` quando não houver evidência.

## Backup, rollback e recuperação

O backup fica ao lado do destino com nome `server.host-switch-backup-<data>`. Se uma falha ocorrer antes da troca, o destino permanece intacto. Se a troca falhar depois de mover o destino, o importador tenta renomear o backup de volta.

Para restauração manual, confirme que a instância está parada, renomeie o destino incompleto para outra pasta e renomeie o backup para o nome original. Nunca misture arquivos manualmente enquanto Java ou o MCSManager estiverem iniciando/parando a instância.

## Compatibilidade e erros comuns

- Minecraft/software/versão conhecidos e diferentes são bloqueadores.
- Java, mods, plugins ou valores ausentes geram avisos e estado de compatibilidade `unknown`; isso não é declarado compatível.
- Consulte Java com `java -version`. Minecraft é lido de `manifest.json` quando presente; Forge/Arclight são inferidos somente de nomes de JAR reconhecíveis.
- “Estado não confirmado”: configure credenciais/IDs do MCSManager ou o verificador local.
- “Arquivo mudou durante a exportação”: a instalação ainda está sendo alterada; confirme parada e tente de novo.
- “Hash/tamanho inválido”: descarte o ZIP e transfira novamente.
- “Caminho inseguro/colisão”: o pacote é rejeitado antes de qualquer escrita.
- “Espaço insuficiente”: libere espaço para temporário, destino e backup. O sistema operacional também pode interromper a extração; o destino original continua preservado.

## Ensaio seguro

Use uma cópia pequena da instalação em um diretório temporário, configure `HOST_SWITCH_SERVER_ROOT` para ela e use outro diretório vazio como destino no Windows. Valide mundo, inventário, dimensões, mods/plugins e permissões antes de repetir com o mundo real. Nunca use os testes automatizados contra `../server`: eles criam fixtures próprias no diretório temporário do sistema.

## Formato v1

O ZIP contém `manifest.json` e `payload/<caminho relativo>`. O esquema está em `docs/host-switch-manifest.schema.json`. Hashes garantem integridade acidental; não garantem autenticidade. Pacotes com versões futuras são rejeitados até haver suporte explícito.

## Limitações atuais

- Não há transferência automática, assinatura digital nem lock distribuído entre os dois computadores.
- A API mantém o histórico de operações em memória; pacotes permanecem em `.host-switch/exports` até limpeza administrativa.
- A compatibilidade de mods/plugins é comparada por nomes de JAR, não por semântica interna.
- Não existe garantia de espaço pré-reservado pelo sistema operacional; tamanho expandido é validado e falhas de escrita preservam o destino/backup.
- A ativação do host novo e a desativação contínua do antigo continuam sendo etapas humanas.
