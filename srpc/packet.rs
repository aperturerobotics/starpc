//! Packet utility functions and validation.
//!
//! This module provides helper functions for creating and validating
//! starpc protocol packets.

use crate::error::{Error, Result};
use crate::proto::{packet::Body, CallData, CallStart, Packet};
use crate::transport::encode_optional_data;
use bytes::Bytes;

/// Creates a new CallStart packet.
///
/// # Arguments
/// * `service` - The service ID
/// * `method` - The method ID
/// * `data` - Optional initial data (None = no data, Some(empty) = empty data)
pub fn new_call_start(
    service: impl Into<String>,
    method: impl Into<String>,
    data: Option<Bytes>,
) -> Packet {
    let (data_bytes, data_is_zero) = encode_optional_data(data);

    Packet {
        body: Some(Body::CallStart(CallStart {
            rpc_service: service.into(),
            rpc_method: method.into(),
            data: data_bytes,
            data_is_zero,
        })),
    }
}

/// Creates a new CallData packet with data.
///
/// # Arguments
/// * `data` - The data to send (can be empty)
pub fn new_call_data(data: Vec<u8>) -> Packet {
    let data_is_zero = data.is_empty();
    Packet {
        body: Some(Body::CallData(CallData {
            data,
            data_is_zero,
            complete: false,
            error: String::new(),
        })),
    }
}

/// Creates a new CallData packet with optional data and flags.
///
/// # Arguments
/// * `data` - Optional data bytes
/// * `data_is_zero` - True if empty data should be sent
/// * `complete` - True if this completes the stream
/// * `error` - Optional error message
pub fn new_call_data_full(
    data: Option<Bytes>,
    complete: bool,
    error: Option<String>,
) -> Packet {
    let (data_bytes, data_is_zero) = encode_optional_data(data);

    Packet {
        body: Some(Body::CallData(CallData {
            data: data_bytes,
            data_is_zero,
            complete: complete || error.is_some(),
            error: error.unwrap_or_default(),
        })),
    }
}

/// Creates a new CallData packet indicating completion.
pub fn new_call_complete() -> Packet {
    Packet {
        body: Some(Body::CallData(CallData {
            data: vec![],
            data_is_zero: false,
            complete: true,
            error: String::new(),
        })),
    }
}

/// Creates a new CallData packet with an error.
///
/// # Arguments
/// * `error` - The error message
pub fn new_call_error(error: impl Into<String>) -> Packet {
    Packet {
        body: Some(Body::CallData(CallData {
            data: vec![],
            data_is_zero: false,
            complete: true,
            error: error.into(),
        })),
    }
}

/// Creates a new CallCancel packet.
pub fn new_call_cancel() -> Packet {
    Packet {
        body: Some(Body::CallCancel(true)),
    }
}

/// Extracts the body type name for debugging.
pub fn body_type_name(packet: &Packet) -> &'static str {
    match &packet.body {
        Some(Body::CallStart(_)) => "CallStart",
        Some(Body::CallData(_)) => "CallData",
        Some(Body::CallCancel(_)) => "CallCancel",
        None => "Empty",
    }
}

/// Packet validation trait.
///
/// Provides validation methods matching the Go implementation's
/// `Packet.Validate()`, `CallStart.Validate()`, and `CallData.Validate()`.
pub trait Validate {
    /// Validates the packet/message, returning an error if invalid.
    fn validate(&self) -> Result<()>;
}

impl Validate for Packet {
    fn validate(&self) -> Result<()> {
        match &self.body {
            Some(Body::CallStart(cs)) => cs.validate(),
            Some(Body::CallData(cd)) => cd.validate(),
            Some(Body::CallCancel(_)) => Ok(()),
            None => Err(Error::EmptyPacket),
        }
    }
}

impl Validate for CallStart {
    fn validate(&self) -> Result<()> {
        if self.rpc_method.is_empty() {
            return Err(Error::EmptyMethodId);
        }
        if self.rpc_service.is_empty() {
            return Err(Error::EmptyServiceId);
        }
        Ok(())
    }
}

impl Validate for CallData {
    fn validate(&self) -> Result<()> {
        // A CallData packet must have at least one of:
        // - Non-empty data
        // - data_is_zero flag set (indicating intentionally empty data)
        // - complete flag set
        // - error message
        if self.data.is_empty()
            && !self.data_is_zero
            && !self.complete
            && self.error.is_empty()
        {
            return Err(Error::EmptyPacket);
        }
        Ok(())
    }
}

/// Extension trait for Packet to check body type.
impl Packet {
    /// Returns true if this is a CallStart packet.
    pub fn is_call_start(&self) -> bool {
        matches!(&self.body, Some(Body::CallStart(_)))
    }

    /// Returns true if this is a CallData packet.
    pub fn is_call_data(&self) -> bool {
        matches!(&self.body, Some(Body::CallData(_)))
    }

    /// Returns true if this is a CallCancel packet.
    pub fn is_call_cancel(&self) -> bool {
        matches!(&self.body, Some(Body::CallCancel(true)))
    }

    /// Extracts the CallStart body, if present.
    pub fn into_call_start(self) -> Option<CallStart> {
        match self.body {
            Some(Body::CallStart(cs)) => Some(cs),
            _ => None,
        }
    }

    /// Extracts the CallData body, if present.
    pub fn into_call_data(self) -> Option<CallData> {
        match self.body {
            Some(Body::CallData(cd)) => Some(cd),
            _ => None,
        }
    }

    /// Returns true if this packet indicates completion (CallData with complete=true or error).
    pub fn is_complete(&self) -> bool {
        match &self.body {
            Some(Body::CallData(cd)) => cd.complete || !cd.error.is_empty(),
            Some(Body::CallCancel(true)) => true,
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_call_start() {
        let pkt = new_call_start("test.Service", "Method", None);
        let cs = pkt.into_call_start().unwrap();
        assert_eq!(cs.rpc_service, "test.Service");
        assert_eq!(cs.rpc_method, "Method");
        assert!(cs.data.is_empty());
        assert!(!cs.data_is_zero);
    }

    #[test]
    fn test_new_call_start_with_empty_data() {
        let pkt = new_call_start("svc", "method", Some(Bytes::new()));
        let cs = pkt.into_call_start().unwrap();
        assert!(cs.data.is_empty());
        assert!(cs.data_is_zero);
    }

    #[test]
    fn test_new_call_start_with_data() {
        let pkt = new_call_start("svc", "method", Some(Bytes::from(vec![1, 2, 3])));
        let cs = pkt.into_call_start().unwrap();
        assert_eq!(cs.data, vec![1, 2, 3]);
        assert!(!cs.data_is_zero);
    }

    #[test]
    fn test_validate_call_start_valid() {
        let cs = CallStart {
            rpc_service: "svc".into(),
            rpc_method: "method".into(),
            data: vec![],
            data_is_zero: false,
        };
        assert!(cs.validate().is_ok());
    }

    #[test]
    fn test_validate_call_start_empty_method() {
        let cs = CallStart {
            rpc_service: "svc".into(),
            rpc_method: String::new(),
            data: vec![],
            data_is_zero: false,
        };
        assert!(matches!(cs.validate(), Err(Error::EmptyMethodId)));
    }

    #[test]
    fn test_validate_call_start_empty_service() {
        let cs = CallStart {
            rpc_service: String::new(),
            rpc_method: "method".into(),
            data: vec![],
            data_is_zero: false,
        };
        assert!(matches!(cs.validate(), Err(Error::EmptyServiceId)));
    }

    #[test]
    fn test_validate_call_data_valid_with_data() {
        let cd = CallData {
            data: vec![1, 2, 3],
            data_is_zero: false,
            complete: false,
            error: String::new(),
        };
        assert!(cd.validate().is_ok());
    }

    #[test]
    fn test_validate_call_data_valid_with_complete() {
        let cd = CallData {
            data: vec![],
            data_is_zero: false,
            complete: true,
            error: String::new(),
        };
        assert!(cd.validate().is_ok());
    }

    #[test]
    fn test_validate_call_data_valid_with_error() {
        let cd = CallData {
            data: vec![],
            data_is_zero: false,
            complete: false,
            error: "some error".into(),
        };
        assert!(cd.validate().is_ok());
    }

    #[test]
    fn test_validate_call_data_valid_with_zero_data() {
        let cd = CallData {
            data: vec![],
            data_is_zero: true,
            complete: false,
            error: String::new(),
        };
        assert!(cd.validate().is_ok());
    }

    #[test]
    fn test_validate_call_data_invalid_empty() {
        let cd = CallData {
            data: vec![],
            data_is_zero: false,
            complete: false,
            error: String::new(),
        };
        assert!(matches!(cd.validate(), Err(Error::EmptyPacket)));
    }

    #[test]
    fn test_validate_packet_empty() {
        let pkt = Packet { body: None };
        assert!(matches!(pkt.validate(), Err(Error::EmptyPacket)));
    }
}
