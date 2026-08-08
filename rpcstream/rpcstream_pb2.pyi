from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class RpcStreamPacket(_message.Message):
    __slots__ = ("init", "ack", "data")
    INIT_FIELD_NUMBER: _ClassVar[int]
    ACK_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    init: RpcStreamInit
    ack: RpcAck
    data: bytes
    def __init__(self, init: _Optional[_Union[RpcStreamInit, _Mapping]] = ..., ack: _Optional[_Union[RpcAck, _Mapping]] = ..., data: _Optional[bytes] = ...) -> None: ...

class RpcStreamInit(_message.Message):
    __slots__ = ("component_id",)
    COMPONENT_ID_FIELD_NUMBER: _ClassVar[int]
    component_id: str
    def __init__(self, component_id: _Optional[str] = ...) -> None: ...

class RpcAck(_message.Message):
    __slots__ = ("error",)
    ERROR_FIELD_NUMBER: _ClassVar[int]
    error: str
    def __init__(self, error: _Optional[str] = ...) -> None: ...
