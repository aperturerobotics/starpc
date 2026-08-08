from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Packet(_message.Message):
    __slots__ = ("call_start", "call_data", "call_cancel")
    CALL_START_FIELD_NUMBER: _ClassVar[int]
    CALL_DATA_FIELD_NUMBER: _ClassVar[int]
    CALL_CANCEL_FIELD_NUMBER: _ClassVar[int]
    call_start: CallStart
    call_data: CallData
    call_cancel: bool
    def __init__(self, call_start: _Optional[_Union[CallStart, _Mapping]] = ..., call_data: _Optional[_Union[CallData, _Mapping]] = ..., call_cancel: _Optional[bool] = ...) -> None: ...

class CallStart(_message.Message):
    __slots__ = ("rpc_service", "rpc_method", "data", "data_is_zero")
    RPC_SERVICE_FIELD_NUMBER: _ClassVar[int]
    RPC_METHOD_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    DATA_IS_ZERO_FIELD_NUMBER: _ClassVar[int]
    rpc_service: str
    rpc_method: str
    data: bytes
    data_is_zero: bool
    def __init__(self, rpc_service: _Optional[str] = ..., rpc_method: _Optional[str] = ..., data: _Optional[bytes] = ..., data_is_zero: _Optional[bool] = ...) -> None: ...

class CallData(_message.Message):
    __slots__ = ("data", "data_is_zero", "complete", "error")
    DATA_FIELD_NUMBER: _ClassVar[int]
    DATA_IS_ZERO_FIELD_NUMBER: _ClassVar[int]
    COMPLETE_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    data: bytes
    data_is_zero: bool
    complete: bool
    error: str
    def __init__(self, data: _Optional[bytes] = ..., data_is_zero: _Optional[bool] = ..., complete: _Optional[bool] = ..., error: _Optional[str] = ...) -> None: ...
