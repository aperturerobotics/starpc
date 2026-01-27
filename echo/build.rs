use std::io::Result;
use std::path::PathBuf;

fn main() -> Result<()> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // Use simplified proto without rpcstream dependency
    let proto_path = manifest_dir.join("echo_rust.proto");

    println!("cargo:rerun-if-changed={}", proto_path.display());

    starpc_build::configure()
        .compile_protos(&[proto_path], &[&manifest_dir])?;

    Ok(())
}
