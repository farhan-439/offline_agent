#!/bin/sh
# Start the single Bonsai 2 4B server used by Kindred: chat, tools, vision AND embeddings.
# Embeddings are what make hybrid retrieval work; without --embeddings the app degrades to BM25.
# Do not use the 9B weights here (see docs/MEMORY_STATUS.md).
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -d "$ROOT/bonsai-demo" ]; then
  DEFAULT_DEMO_DIR="$ROOT/bonsai-demo"
else
  DEFAULT_DEMO_DIR="$ROOT/../Bionic-Test/bonsai-demo"
fi
DEMO_DIR="${BONSAI_DEMO_DIR:-$DEFAULT_DEMO_DIR}"
MODEL="${BONSAI_GGUF:-$DEMO_DIR/models/bonsai2-gguf/4B/Ternary-Bonsai-2-4B-PQ2_0.gguf}"
MMPROJ="${BONSAI_MMPROJ:-$DEMO_DIR/models/bonsai2-gguf/4B/Ternary-Bonsai-2-4B-mmproj-Q8_0.gguf}"
BIN="${BONSAI_BIN:-$DEMO_DIR/bin/mac/llama-server}"

[ -x "$BIN" ] || { echo "llama-server not found at $BIN" >&2; exit 1; }
[ -f "$MODEL" ] || { echo "model not found at $MODEL" >&2; exit 1; }

exec "$BIN" \
  -m "$MODEL" \
  --host "${BONSAI_HOST:-127.0.0.1}" \
  --port "${BONSAI_PORT:-8080}" \
  -ngl 99 -fa on -c 8192 \
  --embeddings --pooling mean \
  --temp 0.7 --top-p 0.8 --top-k 20 --min-p 0 --presence-penalty 1.5 \
  --repeat-penalty 1 --repeat-last-n 64 \
  --jinja \
  --mmproj "$MMPROJ" --image-max-tokens 1024 \
  --chat-template-kwargs '{"enable_thinking":false}' \
  -np 1 --alias "${BONSAI_MODEL:-bonsai-4b}"
