use bytes::BytesMut;
use prost::Message;
use serde_json::Value;
use starpc::{codec::PacketCodec, error::Error, packet::Validate, proto::Packet};
use tokio_util::codec::{Decoder, Encoder};

fn vectors() -> Value {
    serde_json::from_str(include_str!("../testdata/packet-codec-vectors.json")).unwrap()
}
fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn golden_frames_and_packet_validation() {
    for case in vectors()["cases"].as_array().unwrap() {
        let Some(packet_hex) = case.get("packet_hex").and_then(Value::as_str) else {
            continue;
        };
        let Some(frame_hex) = case.get("frame_hex").and_then(Value::as_str) else {
            continue;
        };
        let packet_bytes = hex(packet_hex);
        let packet = Packet::decode(&packet_bytes[..]).unwrap();
        assert_eq!(packet.encode_to_vec(), packet_bytes);
        let mut codec = PacketCodec::new();
        let mut frame = BytesMut::new();
        codec.encode(packet.clone(), &mut frame).unwrap();
        assert_eq!(frame.to_vec(), hex(frame_hex));
        assert_eq!(codec.decode(&mut frame).unwrap(), Some(packet));
        assert!(frame.is_empty());
    }
    let document = vectors();
    for name in [
        "invalid_empty_packet",
        "invalid_empty_service_id",
        "invalid_empty_method_id",
    ] {
        let case = document["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap();
        let packet = match name {
            "invalid_empty_packet" => Packet { body: None },
            "invalid_empty_service_id" => Packet {
                body: Some(starpc::proto::packet::Body::CallStart(
                    starpc::proto::CallStart {
                        rpc_service: "".into(),
                        rpc_method: "method".into(),
                        ..Default::default()
                    },
                )),
            },
            _ => Packet {
                body: Some(starpc::proto::packet::Body::CallStart(
                    starpc::proto::CallStart {
                        rpc_service: "svc".into(),
                        rpc_method: "".into(),
                        ..Default::default()
                    },
                )),
            },
        };
        assert_eq!(
            packet.validate().unwrap_err().to_string(),
            match case["expect_error"].as_str().unwrap() {
                "empty_packet" => "invalid empty packet",
                "empty_service_id" => "service id empty",
                _ => "method id empty",
            }
        );
    }
}

#[test]
fn invalid_fragmented_and_coalesced_frames() {
    let document = vectors();
    let cases = document["cases"].as_array().unwrap();
    for case in cases
        .iter()
        .filter(|c| c.get("packet_hex").is_some() && c.get("frame_hex").is_some())
    {
        let raw = hex(case["frame_hex"].as_str().unwrap());
        for split in 0..raw.len() {
            let mut codec = PacketCodec::new();
            let mut buf = BytesMut::from(&raw[..split]);
            assert!(codec.decode(&mut buf).unwrap().is_none());
            buf.extend_from_slice(&raw[split..]);
            assert!(codec.decode(&mut buf).unwrap().is_some());
            assert!(buf.is_empty());
        }
    }
    let mut codec = PacketCodec::new();
    let mut buf = BytesMut::new();
    for case in cases
        .iter()
        .filter(|c| c.get("packet_hex").is_some() && c.get("frame_hex").is_some())
    {
        buf.extend_from_slice(&hex(case["frame_hex"].as_str().unwrap()));
    }
    let mut count = 0;
    while codec.decode(&mut buf).unwrap().is_some() {
        count += 1;
    }
    assert_eq!(count, 6);
    assert!(buf.is_empty());
    for case in cases
        .iter()
        .filter(|c| c.get("expect_error").is_some() && c.get("frame_hex").is_some())
    {
        let mut codec = PacketCodec::new();
        let mut buf = BytesMut::from(hex(case["frame_hex"].as_str().unwrap()).as_slice());
        match case["expect_error"].as_str().unwrap() {
            "invalid_length" => assert!(matches!(
                codec.decode(&mut buf),
                Err(Error::MessageSizeZero)
            )),
            "oversized_frame" => assert!(matches!(
                codec.decode(&mut buf),
                Err(Error::MessageTooLarge(_, _))
            )),
            "malformed_packet" => assert!(matches!(
                codec.decode(&mut buf),
                Err(Error::InvalidMessage(_))
            )),
            "truncated_frame" => assert!(codec.decode(&mut buf).unwrap().is_none()),
            _ => unreachable!(),
        }
    }
}

#[test]
fn encoder_rejects_empty_packet() {
    let packet = Packet { body: None };
    let mut frame = BytesMut::new();
    assert!(matches!(
        PacketCodec::new().encode(packet.clone(), &mut frame),
        Err(Error::MessageSizeZero)
    ));
    assert!(matches!(
        starpc::codec::encode_packet(&packet),
        Err(Error::MessageSizeZero)
    ));
    assert!(frame.is_empty());
}
