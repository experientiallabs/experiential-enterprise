#!/usr/bin/env bash
set -euo pipefail

base_url="${1:?usage: smoke_models.sh BASE_URL}"
: "${EXPLABS_EXPERIENTIAL_CLOUD_API_KEY:?Set EXPLABS_EXPERIENTIAL_CLOUD_API_KEY}"

base_url="${base_url%/}"
models=(deepseek-v4-flash qwen3.8-27b)
response_file="$(mktemp)"
trap 'rm -f "${response_file}"' EXIT

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${EXPLABS_EXPERIENTIAL_CLOUD_API_KEY}" \
  "${base_url}/models" >"${response_file}"

for model in "${models[@]}"; do
  jq -e --arg model "${model}" \
    '.data | any(.id == $model)' "${response_file}" >/dev/null

  jq -n --arg model "${model}" '{
    model: $model,
    messages: [{role: "user", content: "Reply with OK."}],
    max_tokens: 8,
    temperature: 0
  }' | curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${EXPLABS_EXPERIENTIAL_CLOUD_API_KEY}" \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "${base_url}/chat/completions" >"${response_file}"

  jq -e '.choices | length > 0' "${response_file}" >/dev/null
  echo "[PASS] ${model}"
done
