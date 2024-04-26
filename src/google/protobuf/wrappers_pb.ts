// Protocol Buffers - Google's data interchange format
// Copyright 2008 Google Inc.  All rights reserved.
// https://developers.google.com/protocol-buffers/
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//     * Redistributions of source code must retain the above copyright
// notice, this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above
// copyright notice, this list of conditions and the following disclaimer
// in the documentation and/or other materials provided with the
// distribution.
//     * Neither the name of Google Inc. nor the names of its
// contributors may be used to endorse or promote products derived from
// this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//
// Wrappers for primitive (non-message) types. These types are useful
// for embedding primitives in the `google.protobuf.Any` type and for places
// where we need to distinguish between the absence of a primitive
// typed field and its default value.
//
// These wrappers have no meaningful use within repeated fields as they lack
// the ability to detect presence on individual elements.
// These wrappers have no meaningful use within a map or a oneof since
// individual entries of a map or fields of a oneof can already detect presence.

// @generated by protoc-gen-es-lite unknown with parameter "target=ts,ts_nocheck=false"
// @generated from file google/protobuf/wrappers.proto (package google.protobuf, syntax proto3)
/* eslint-disable */

import { createMessageType, Message, MessageType, PartialFieldInfo } from "@aptre/protobuf-es-lite";

export const protobufPackage = "google.protobuf";

/**
 * Wrapper message for `double`.
 *
 * The JSON representation for `DoubleValue` is JSON number.
 *
 * protobuf-go-lite:disable-text
 *
 * @generated from message google.protobuf.DoubleValue
 */
export interface DoubleValue extends Message<DoubleValue> {
  /**
   * The double value.
   *
   * @generated from field: double value = 1;
   */
  value?: number;

}

export const DoubleValue: MessageType<DoubleValue> = createMessageType(
  {
    typeName: "google.protobuf.DoubleValue",
    fields: [
        { no: 1, name: "value", kind: "scalar", T: 1 /* ScalarType.DOUBLE */ },
    ] as readonly PartialFieldInfo[],
    packedByDefault: true,
  },
);

/**
 * Wrapper message for `float`.
 *
 * The JSON representation for `FloatValue` is JSON number.
 *
 * protobuf-go-lite:disable-text
 *
 * @generated from message google.protobuf.FloatValue
 */
export interface FloatValue extends Message<FloatValue> {
  /**
   * The float value.
   *
   * @generated from field: float value = 1;
   */
  value?: number;

}

export const FloatValue: MessageType<FloatValue> = createMessageType(
  {
    typeName: "google.protobuf.FloatValue",
    fields: [
        { no: 1, name: "value", kind: "scalar", T: 2 /* ScalarType.FLOAT */ },
    ] as readonly PartialFieldInfo[],
    packedByDefault: true,
  },
);

/**
 * Wrapper message for `int64`.
 *
 * The JSON representation for `Int64Value` is JSON string.
 *
 * protobuf-go-lite:disable-text
 *
 * @generated from message google.protobuf.Int64Value
 */
export interface Int64Value extends Message<Int64Value> {
  /**
   * The int64 value.
   *
   * @generated from field: int64 value = 1;
   */
  value?: bigint;

}

export const Int64Value: MessageType<Int64Value> = createMessageType(
  {
    typeName: "google.protobuf.Int64Value",
    fields: [
        { no: 1, name: "value", kind: "scalar", T: 3 /* ScalarType.INT64 */ },
    ] as readonly PartialFieldInfo[],
    packedByDefault: true,
  },
);

/**
 * Wrapper message for `uint64`.
 *
 * The JSON representation for `UInt64Value` is JSON string.
 *
 * protobuf-go-lite:disable-text
 *
 * @generated from message google.protobuf.UInt64Value
 */
export interface UInt64Value extends Message<UInt64Value> {
  /**
   * The uint64 value.
   *
   * @generated from field: uint64 value = 1;
   */
  value?: bigint;

}

export const UInt64Value: MessageType<UInt64Value> = createMessageType(
  {
    typeName: "google.protobuf.UInt64Value",
    fields: [
        { no: 1, name: "value", kind: "scalar", T: 4 /* ScalarType.UINT64 */ },
    ] as readonly PartialFieldInfo[],
    packedByDefault: true,
  },
);

/**
 * Wrapper message for `int32`.
 *
 * The JSON representation for `Int32Value` is JSON number.
 *
 * protobuf-go-lite:disable-text
 *
 * @generated from message google.protobuf.Int32Value
 */
export interface Int32Value extends Message<Int32Value> {
  /**
   * The int32 value.
   *
   * @generated from field: int32 value = 1;
   */
  value?: number;

}

export const Int32Value: MessageType<Int32Value> = createMessageType(
  {
    typeName: "google.protobuf.Int32Value",
    fields: [
        { no: 1, name: "value", kind: "scalar", T: 5 /* ScalarType.INT32 */ },
    ] as readonly PartialFieldInfo[],
    packedByDefault: true,
  },
);

/**
 * Wrapper message for `uint32`.
 *
 * The JSON representation for `UInt32Value` is JSON number.
 *
 * protobuf-go-lite:disable-text
 *
 * @generated from message google.protobuf.UInt32Value
 */
export interface UInt32Value extends Message<UInt32Value> {
  /**
   * The uint32 value.
   *
   * @generated from field: uint32 value = 1;
   */
  value?: number;

}

export const UInt32Value: MessageType<UInt32Value> = createMessageType(
  {
    typeName: "google.protobuf.UInt32Value",
    fields: [
        { no: 1, name: "value", kind: "scalar", T: 13 /* ScalarType.UINT32 */ },
    ] as readonly PartialFieldInfo[],
    packedByDefault: true,
  },
);

/**
 * Wrapper message for `bool`.
 *
 * The JSON representation for `BoolValue` is JSON `true` and `false`.
 *
 * protobuf-go-lite:disable-text
 *
 * @generated from message google.protobuf.BoolValue
 */
export interface BoolValue extends Message<BoolValue> {
  /**
   * The bool value.
   *
   * @generated from field: bool value = 1;
   */
  value?: boolean;

}

export const BoolValue: MessageType<BoolValue> = createMessageType(
  {
    typeName: "google.protobuf.BoolValue",
    fields: [
        { no: 1, name: "value", kind: "scalar", T: 8 /* ScalarType.BOOL */ },
    ] as readonly PartialFieldInfo[],
    packedByDefault: true,
  },
);

/**
 * Wrapper message for `string`.
 *
 * The JSON representation for `StringValue` is JSON string.
 *
 * protobuf-go-lite:disable-text
 *
 * @generated from message google.protobuf.StringValue
 */
export interface StringValue extends Message<StringValue> {
  /**
   * The string value.
   *
   * @generated from field: string value = 1;
   */
  value?: string;

}

export const StringValue: MessageType<StringValue> = createMessageType(
  {
    typeName: "google.protobuf.StringValue",
    fields: [
        { no: 1, name: "value", kind: "scalar", T: 9 /* ScalarType.STRING */ },
    ] as readonly PartialFieldInfo[],
    packedByDefault: true,
  },
);

/**
 * Wrapper message for `bytes`.
 *
 * The JSON representation for `BytesValue` is JSON string.
 *
 * protobuf-go-lite:disable-text
 *
 * @generated from message google.protobuf.BytesValue
 */
export interface BytesValue extends Message<BytesValue> {
  /**
   * The bytes value.
   *
   * @generated from field: bytes value = 1;
   */
  value?: Uint8Array;

}

export const BytesValue: MessageType<BytesValue> = createMessageType(
  {
    typeName: "google.protobuf.BytesValue",
    fields: [
        { no: 1, name: "value", kind: "scalar", T: 12 /* ScalarType.BYTES */ },
    ] as readonly PartialFieldInfo[],
    packedByDefault: true,
  },
);
