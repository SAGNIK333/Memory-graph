# RP Memory Graph (SillyTavern extension)

Builds a per-chat knowledge graph (characters, places, objects, plot threads + relationships) and injects only the relevant nodes into each prompt.

## Install / update
Install from the GitHub link in SillyTavern (Extensions -> Install extension). To update after changing files in the repo: Extensions -> Manage extensions -> update arrow, then reload the page.

## Use
- After N new messages (auto, default 40) or when you press **Summarize now**, the model reads only the messages added since the last summary and updates the graph.
- Before every reply, the last few messages are matched against the graph (name/alias/keyword, plus optional embeddings) and the top nodes plus their relationships are injected.
- **View / edit graph** opens a map. Tap a node to edit it.
- **Last injected block** shows exactly what was sent; **Last raw model reply** shows what the summarizer got back.

## How summaries stay reliable
- **Progress is saved after every part.** If something fails, finished parts stay saved and **Summarize now** resumes from where it stopped. Old messages are never sent again.
- **Retry, then split.** A failing part is retried once with a stricter instruction, then split in half and each half tried. A cut-off reply is never trusted unless nothing else works.
- **Existing nodes are handled in two tiers:** nodes the new messages mention are sent with their full current text, all other nodes by name only. Names are matched loosely ("The Moonpetal" = "Moonpetal", "Deryne" = "Deryne (Mondstadt Annex)"), and ambiguous names create a new node rather than a wrong merge.
- **Stop** button halts after the current call; everything finished is kept.

## Streaming
Summaries are streamed so providers do not time out on long thinking. The extension learns your connection (source, model, proxy) from the last request SillyTavern made, so it works with whatever API you already use and needs no extra key. Until you have sent one chat message in a session, the first summary uses a standard (non-streaming) request. If the backend rejects a streaming request, it falls back to standard requests automatically.

Settings that matter for thinking models:
- **Summary max tokens** (default 8000): reasoning counts against this. If you see "hit the token limit", raise it.
- **Thinking effort for summaries**: Low / Minimum lowers reasoning on providers that support it.
- **Stall timeout**: gives up only if the API sends *nothing* for this long (keep-alives and reasoning count as data).
- **Characters per summary part**: smaller parts mean shorter, safer replies.

## Embeddings (BGE-M3)
Tick "Use embeddings" and point it at any OpenAI-compatible `/v1/embeddings` or Ollama endpoint, e.g. `http://localhost:11434/v1/embeddings`, model `bge-m3`. If it fails, matching silently falls back to keywords.

## Tests
`node test.mjs; node test2.mjs; node test3.mjs; node test4.mjs; node test5.mjs` (logic, parser, streaming client, graph rules, and the whole summarizer against a fake SillyTavern).
