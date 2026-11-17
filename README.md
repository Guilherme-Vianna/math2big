# math2big

OCR de matemática: imagem (impressa ou manuscrita) → LaTeX, com visualização renderizada.
Interface em preto e branco (tema claro/escuro), funciona no desktop e no celular.

## Como rodar (Docker)

1. Copie `.env.example` para `.env` e coloque sua chave do Gemini
   (gere em https://aistudio.google.com/apikey):

   ```
   GEMINI_API_KEY=sua-chave
   ```

   O `.env` não entra na imagem nem no Git (está no `.dockerignore` e no `.gitignore`).

2. Suba o container:

   ```powershell
   docker compose up -d --build
   ```

   Abra http://localhost:8765. Comandos úteis:

   ```powershell
   docker compose logs -f     # ver logs
   docker compose down        # parar
   ```

   O container reinicia sozinho (`restart: unless-stopped`), roda sem root e tem healthcheck.

### Sem Docker (desenvolvimento)

```powershell
.\run.ps1
```

## Como usar

- **Envie** arrastando, clicando, colando com **Ctrl+V** ou tirando foto no celular. Várias páginas de uma vez: cada uma vira uma aba e a conversão começa sozinha.
- **Acompanhe** o texto aparecendo em tempo real (streaming).
- **Ajuste a foto**: *Girar* e *Recortar* (só a área que interessa) reconvertem automaticamente.
- **Confira** original e resultado lado a lado; símbolos duvidosos aparecem marcados com `[?]` e o selo "trechos para conferir" leva até eles.
- **Copie**: clique numa fórmula para copiar só ela; *Copiar LaTeX* copia todas; *Exportar* tem Markdown, **Word** (equação editável), `.tex` e `.md` — por página ou o documento inteiro.
- **Edite** no modo *Editar* com prévia ao vivo e "Restaurar original".
- **Histórico** com busca, salvo no navegador. Pressione **?** para ver os atalhos.

## Modelos

A lista no topo é montada a partir dos modelos que a sua chave tem acesso:

- **Gemini Flash mais novo** (padrão) — rápido (~3 s) e preciso para fórmulas complexas.
- **Flash anterior** — alternativa se o mais novo estiver com cota esgotada.
- **Flash Lite** — mais leve e barato, bom para material impresso e limpo.

A imagem é enviada em alta resolução e o modelo roda com raciocínio baixo
(é transcrição, não resolução). Para fixar um padrão: `MATH2BIG_MODEL=gemini-3.7-flash` no `.env`.

Opcional: com `ANTHROPIC_API_KEY` no `.env`, os modelos Claude também aparecem na lista.

## Estrutura

- `Dockerfile`, `docker-compose.yml` — imagem Python 3.13 slim + Uvicorn na porta 8765.
- `server.py` — API FastAPI (`POST /api/ocr`, `GET /api/models`).
- `static/` — interface (HTML/CSS/JS puro, KaTeX para renderizar).
