# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""OpenAI-compatible errors without importing a serving engine."""

from __future__ import annotations

from fastapi.responses import JSONResponse


def openai_error_response(
    status_code: int,
    message: str,
    *,
    err_type: str,
    code: str | None = None,
) -> JSONResponse:
    """Return the error envelope expected by OpenAI SDK clients.

    Args:
        status_code: HTTP status code.
        message: Human-facing error message.
        err_type: OpenAI error category.
        code: Optional stable machine-readable code.

    Returns:
        JSON response with the OpenAI-compatible error envelope.
    """
    return JSONResponse(
        {
            "error": {
                "message": message,
                "type": err_type,
                "param": None,
                "code": code,
            }
        },
        status_code=status_code,
    )
