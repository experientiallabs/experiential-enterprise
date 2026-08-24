-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Admit the first-party Experiential Cloud serving lane on model_providers.
-- This is not a BYOK connection type: customers authenticate with a platform
-- xpl_ key, and the worker holds the cluster-private vLLM origin. provider_
-- connections stays unchanged.

-- 1. Widen the catalog provider vocabulary.
alter table public.model_providers
  drop constraint model_providers_provider_check;
alter table public.model_providers
  add constraint model_providers_provider_check check (
    provider in (
      'openai', 'anthropic', 'gemini', 'azure_openai', 'openrouter',
      'bedrock', 'local', 'fireworks', 'modal', 'experiential_cloud'
    )
  );

-- 2. Experiential Cloud may carry a per-row OpenAI-compatible origin (two
-- native vLLM deployments can differ) or omit it so the worker environment
-- supplies one shared origin at catalog-build time. local and modal still
-- require a row-level base_url; every other provider still forbids one.
alter table public.model_providers
  drop constraint model_providers_base_url_check;
alter table public.model_providers
  add constraint model_providers_base_url_check check (
    case
      when provider in ('local', 'modal')
        then base_url is not null
          and base_url ~ '^https?://([A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?(/[A-Za-z0-9._~%/-]*)?$'
          and char_length(base_url) <= 2048
      when provider = 'experiential_cloud'
        then base_url is null
          or (
            base_url ~ '^https?://([A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?(/[A-Za-z0-9._~%/-]*)?$'
            and char_length(base_url) <= 2048
          )
      else base_url is null
    end
  );

comment on column public.model_providers.provider is
  'Serving lane. experiential_cloud is the platform-operated native vLLM lane; it is not a customer BYOK connection type.';
