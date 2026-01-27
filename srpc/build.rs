use std::io::Result;
use std::path::PathBuf;

fn main() -> Result<()> {
    // Get the path to the proto file in the same directory.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let proto_path = manifest_dir.join("rpcproto.proto");

    println!("cargo:rerun-if-changed={}", proto_path.display());

    prost_build::Config::new()
        .compile_protos(&[proto_path], &[&manifest_dir])?;

    Ok(())
}
