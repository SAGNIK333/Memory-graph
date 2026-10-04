# RP Memory Graph (SillyTavern extension)

Builds a per-chat knowledge graph (characters, places, objects, plot threads + relationships) and injects only the relevant nodes into each prompt.

## Install
1. Unzip so the folder is: `SillyTavern/public/scripts/extensions/third-party/rp-memory-graph/`
   (or put the folder in `data/<user>/extensions/rp-memory-graph/`).
2. Restart SillyTavern, hard-refresh the page.
3. Extensions panel -> **RP Memory Graph**.

## Use
- After ~40 messages (auto, or press **Summarize now**) the model reads the new messages and updates the graph. Uses your current API connection, one call per summary.
- Before every reply, the last few messages are matched against the graph (name/alias/keyword, plus optional embeddings) and the top nodes plus their relationships are injected at the chosen depth.
- **View / edit graph** shows a map and an editable JSON; fix anything the model got wrong.
- **Last injected block** shows exactly what was sent, for debugging.

## Embeddings (BGE-M3)
Tick "Use embeddings" and point it at any OpenAI-compatible `/v1/embeddings` or Ollama endpoint, e.g. Ollama with `ollama pull bge-m3`, URL `http://localhost:11434/v1/embeddings`, model `bge-m3`. The browser calls it directly, so Ollama may need `OLLAMA_ORIGINS=*`. If it fails, matching silently falls back to keywords.

Note: ST's built-in Vector Storage models are not reused here; this extension calls its own endpoint.

## Notes
- Written without access to a live SillyTavern, so test on a throwaway chat first.
- Graph is stored in chat metadata (per chat).
- `core.js` holds the pure logic; `node test.mjs` runs its tests.
