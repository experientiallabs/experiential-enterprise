# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the WMO-free OpenAI error envelope."""

import json

from explabs.api.openai_errors import openai_error_response


def test_openai_error_response_uses_sdk_compatible_shape() -> None:
    """SDK clients receive a nested message and stable code."""
    response = openai_error_response(
        404,
        "Model not found",
        err_type="invalid_request_error",
        code="model_not_found",
    )

    assert response.status_code == 404
    assert json.loads(bytes(response.body)) == {
        "error": {
            "message": "Model not found",
            "type": "invalid_request_error",
            "param": None,
            "code": "model_not_found",
        }
    }
