//! Generate the services whose legal names overlap Rust ownership methods.

use std::io;

/// Compiles all call shapes in one module to check dispatch and import names.
fn main() -> io::Result<()> {
    println!("cargo:rerun-if-changed=service.proto");
    starpc::build::configure().compile_protos(&["service.proto"], &["."])
}
