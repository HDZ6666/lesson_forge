from __future__ import annotations

from typing import Annotated

from fastapi import Request

from common.annotation.log_annotation import get_function_parameters_name_by_type


def test_request_parameter_detection_supports_postponed_annotations() -> None:
    namespace: dict[str, object] = {}
    exec(
        'from __future__ import annotations\n'
        'from fastapi import Request\n'
        'async def endpoint(request: Request) -> None:\n'
        '    return None\n',
        namespace,
    )

    assert get_function_parameters_name_by_type(namespace['endpoint'], Request) == ['request']


def test_request_parameter_detection_supports_runtime_annotated() -> None:
    async def endpoint(request: Annotated[Request, 'request marker']) -> None:
        del request

    assert get_function_parameters_name_by_type(endpoint, Request) == ['request']
