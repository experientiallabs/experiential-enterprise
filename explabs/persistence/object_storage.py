# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Platform-owned object-storage configuration and raw upload boundary."""

from __future__ import annotations

import os
from typing import Protocol, cast
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict, Field

from explabs.db.repositories import JsonObject, SupabaseClient

DEFAULT_STORAGE_BUCKET = "explabs-artifacts"
# Official Supabase signed-upload tokens are fixed at two hours and cannot be
# shortened or extended (createSignedUploadUrl / create_signed_upload_url).
SIGNED_UPLOAD_EXPIRES_IN = 2 * 60 * 60


class _RawStorageProxy(Protocol):
    """Private storage3 surface required for raw authenticated uploads."""

    _base_url: object
    _client: httpx.Client


class SignedUploadTicket(BaseModel):
    """Path-bound signed upload credentials with no service-role material."""

    model_config = ConfigDict(frozen=True)

    signed_url: str = Field(min_length=1)
    token: str = Field(min_length=1)
    path: str = Field(min_length=1)
    expires_in: int = Field(default=SIGNED_UPLOAD_EXPIRES_IN, gt=0)


def storage_bucket() -> str:
    """Return the configured private Platform object-storage bucket."""
    return os.environ.get("EXPLABS_STORAGE_BUCKET", DEFAULT_STORAGE_BUCKET)


def create_signed_upload(
    client: SupabaseClient,
    *,
    bucket: str,
    path: str,
) -> SignedUploadTicket:
    """Mint one official signed-upload URL bound to ``path``.

    Official contract (Storage ``createSignedUploadUrl`` / Python
    ``create_signed_upload_url``, 2025-10 upsert changelog): the token is
    valid for two hours, is bound to this exact object path, and does not
    overwrite unless ``upsert`` is set at *create* time. This call never
    sets upsert, so a second PUT to the same path fails instead of
    silently replacing bytes. The returned ticket is only a URL and token —
    never service-role credentials.

    Args:
        client: Service-role Supabase client that is allowed to insert.
        bucket: Private platform bucket.
        path: Server-chosen object path the token may write.

    Returns:
        Path-bound signed upload ticket.

    Raises:
        ValueError: If Storage omits the signed URL or token.
    """
    raw = client.storage.from_(bucket).create_signed_upload_url(path)
    return SignedUploadTicket(
        signed_url=_signed_upload_text(raw, "signed_url", "signedUrl"),
        token=_signed_upload_text(raw, "token"),
        path=path,
        expires_in=SIGNED_UPLOAD_EXPIRES_IN,
    )


def upload_bytes_to_signed_url(
    signed_url: str,
    data: bytes,
    *,
    content_type: str,
) -> None:
    """PUT exact object bytes to an official signed upload URL.

    Official consume path is ``PUT /object/upload/sign/{bucket}/{path}?token=``.
    The Python SDK's ``upload_to_signed_url`` wraps the body as multipart;
    customer traces can match content-inspection rules in that encoding, so
    this helper sends the raw body the same way server-side writes do.

    Args:
        signed_url: URL+token returned by ``create_signed_upload``.
        data: Exact bytes to store.
        content_type: Stored content type.

    Raises:
        httpx.HTTPStatusError: When Storage rejects the upload.
    """
    response = httpx.put(
        signed_url,
        content=data,
        headers={"content-type": content_type},
        timeout=60.0,
    )
    response.raise_for_status()


def _signed_upload_text(raw: JsonObject, *keys: str) -> str:
    """Read one required string from a Storage signed-upload payload."""
    for key in keys:
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    msg = f"signed upload response omitted {'/'.join(keys)}"
    raise ValueError(msg)


def upload_object_raw(
    client: SupabaseClient,
    *,
    bucket: str,
    path: str,
    data: bytes,
    content_type: str,
    upsert: bool = True,
) -> None:
    """Upload one object as a raw request body.

    Supabase Storage's high-level upload method uses multipart encoding.
    Customer traces can match content-inspection rules when sent as multipart,
    so server-side writes use storage3's authenticated client with a raw body.

    Args:
        client: Supabase client whose storage credentials perform the upload.
        bucket: Storage bucket receiving the object.
        path: Object path within the bucket.
        data: Object bytes.
        content_type: Stored content type.
        upsert: Whether an existing object at the path may be overwritten.

    Raises:
        httpx.HTTPStatusError: When Storage returns an error response.
    """
    proxy = cast("_RawStorageProxy", client.storage.from_(bucket))
    response = proxy._client.request(  # noqa: SLF001 - locked storage3 transport seam
        "POST",
        f"{proxy._base_url}object/{quote(bucket)}/{quote(path, safe='/')}",  # noqa: SLF001
        headers={"content-type": content_type, "x-upsert": "true" if upsert else "false"},
        content=data,
    )
    response.raise_for_status()
