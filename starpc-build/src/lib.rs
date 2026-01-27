//! Starpc Build - Code Generation for Starpc
//!
//! This crate provides code generation integration with prost-build for
//! generating starpc service client and server code from protobuf definitions.
//!
//! # Example
//!
//! In your `build.rs`:
//!
//! ```rust,ignore
//! fn main() -> std::io::Result<()> {
//!     starpc_build::configure()
//!         .compile_protos(&["proto/echo.proto"], &["proto"])?;
//!     Ok(())
//! }
//! ```

mod generator;

pub use generator::StarpcServiceGenerator;

/// Returns a prost-build Config preconfigured with starpc service generation.
pub fn configure() -> prost_build::Config {
    let mut config = prost_build::Config::new();
    config.service_generator(Box::new(StarpcServiceGenerator::new()));
    config
}

/// Compiles protobuf files with starpc service generation.
///
/// This is a convenience function that configures prost-build with the
/// starpc service generator and compiles the specified proto files.
pub fn compile_protos(
    protos: &[impl AsRef<std::path::Path>],
    includes: &[impl AsRef<std::path::Path>],
) -> std::io::Result<()> {
    configure().compile_protos(protos, includes)
}
