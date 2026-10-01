//! Build-script helpers for generating Starpc Rust service bindings.
//!
//! Enable the `build` feature and call [`configure`] from a downstream
//! `build.rs` to install the Starpc service generator into `prost-build`.

/// Precedes each generated `close_send` whose error is ignored.
///
/// A failed half-close means the call already ended; returning that error would
/// discard responses the stream already received, and `msg_recv` reports the
/// call's outcome after them.
const HALF_CLOSE_COMMENT: &str =
    "        // A failed half-close means the call ended; msg_recv reports its outcome.";

/// Configures `prost-build` to generate Starpc service bindings.
///
/// The returned config generates normal Prost message types and appends Starpc
/// client/server traits, client implementations, stream wrappers, and handler
/// glue for every protobuf service.
pub fn configure() -> prost_build::Config {
    // Use the packaged compiler and its standard protobuf imports when available.
    let mut config = prost_build::Config::new();
    if let Ok(protoc) = protoc_bin_vendored::protoc_bin_path() {
        config.protoc_executable(protoc);
    }
    if let Ok(include) = protoc_bin_vendored::include_path() {
        config.protoc_arg(format!("--proto_path={}", include.display()));
    }

    // Share runtime message types and generate services beside Prost messages.
    config.extern_path(".rpcstream", "::starpc::rpcstream");
    config.service_generator(Box::new(StarpcServiceGenerator));
    config
}

/// Emits StarPC client and server bindings for Prost services.
#[derive(Debug, Default)]
pub struct StarpcServiceGenerator;

impl prost_build::ServiceGenerator for StarpcServiceGenerator {
    /// Appends one service's clients, streams, and dispatch implementation.
    fn generate(&mut self, service: prost_build::Service, buf: &mut String) {
        let mut gen = Generator::new(service, buf);
        gen.generate();
    }
}

/// Emits bindings for one service into its protobuf package's output module.
struct Generator<'a> {
    /// Service identity, message types, and streaming modes supplied by Prost.
    service: prost_build::Service,
    /// Package output shared by every service in the descriptor graph.
    buf: &'a mut String,
}

impl<'a> Generator<'a> {
    /// Borrows the package output for this service's generation pass.
    fn new(service: prost_build::Service, buf: &'a mut String) -> Self {
        Self { service, buf }
    }

    /// Emits the complete client and server contract for this service.
    fn generate(&mut self) {
        // Resolve stable identifiers before emitting any declarations.
        let service_id = self.service_id();
        let service_name = self.service.name.clone();

        // Keep extension methods available without adding a shared import name.
        self.line("");
        self.line("#[allow(unused_imports)]");
        self.line("use starpc::StreamExt as _;");
        self.line("");
        self.line(&format!("/// Service ID for {}.", service_name));
        self.line(&format!(
            "pub const {}: &str = {:?};",
            service_id_const(&service_name),
            service_id
        ));
        self.line("");

        // Compose the client and server surfaces around the same wire identity.
        self.generate_stream_traits();
        self.generate_client_trait();
        self.generate_client_impl();
        self.generate_stream_impls();
        self.generate_server_trait();
        self.generate_handler();
    }

    /// Declares the send, receive, and close operations for each streaming call.
    fn generate_stream_traits(&mut self) {
        // Emit the client stream contract only for streaming methods.
        let service_name = self.service.name.clone();
        for method in self.service.methods.clone() {
            if !method.client_streaming && !method.server_streaming {
                continue;
            }

            // Name the typed stream and retain its common transport contract.
            let stream_trait = stream_trait_name(&service_name, &method);
            self.line(&format!(
                "/// Stream trait for {}.{}.",
                service_name, method.proto_name
            ));
            self.line("#[starpc::async_trait]");
            self.line(&format!("pub trait {}: Send + Sync {{", stream_trait));
            self.line("    /// Returns the context for this stream.");
            self.line("    fn context(&self) -> &starpc::Context;");

            // Provide typed sends when the caller owns the request stream.
            if method.client_streaming {
                self.line("    /// Sends a message on the stream.");
                self.line(&format!(
                    "    async fn send(&self, msg: &{}) -> starpc::Result<()>;",
                    method.input_type
                ));
            }

            // Provide typed receives when the server owns the response stream.
            if method.server_streaming {
                self.line("    /// Receives a message from the stream.");
                self.line(&format!(
                    "    async fn recv(&self) -> starpc::Result<{}>;",
                    method.output_type
                ));
            }

            // Preserve the final response after half-closing a request stream.
            if method.client_streaming && !method.server_streaming {
                self.line("    /// Closes the send side and receives the response.");
                self.line(&format!(
                    "    async fn close_and_recv(&self) -> starpc::Result<{}>;",
                    method.output_type
                ));
            } else {
                self.line("    /// Closes the stream.");
                self.line("    async fn close(&self) -> starpc::Result<()>;");
            }
            self.line("}");
            self.line("");
        }
    }

    /// Declares the caller-facing methods for all four RPC shapes.
    fn generate_client_trait(&mut self) {
        // Declare the caller contract before its typed methods.
        let service_name = self.service.name.clone();
        self.line(&format!("/// Client trait for {}.", service_name));
        self.line("#[starpc::async_trait]");
        self.line(&format!("pub trait {}Client: Send + Sync {{", service_name));

        // Select each method signature from the descriptor streaming modes.
        for method in self.service.methods.clone() {
            self.line(&format!("    /// {}.", method.proto_name));
            self.line(&format!(
                "    {};",
                client_trait_method(&service_name, &method)
            ));
        }
        self.line("}");
        self.line("");
    }

    /// Implements calls through a retained transport client.
    fn generate_client_impl(&mut self) {
        // Retain even an empty service's client for its declared lifetime.
        let service_id = self.service_id();
        let service_name = self.service.name.clone();
        let client_field = if self.service.methods.is_empty() {
            "_client"
        } else {
            "client"
        };

        // Emit the client handle and its constructor.
        self.line(&format!("/// Client implementation for {}.", service_name));
        self.line(&format!("pub struct {}ClientImpl<C> {{", service_name));
        self.line(&format!("    {client_field}: C,"));
        self.line("}");
        self.line("");
        self.line(&format!(
            "impl<C: starpc::Client> {}ClientImpl<C> {{",
            service_name
        ));
        self.line("    /// Creates a new client.");
        self.line("    pub fn new(client: C) -> Self {");
        if self.service.methods.is_empty() {
            self.line("        Self { _client: client }");
        } else {
            self.line("        Self { client }");
        }
        self.line("    }");
        self.line("}");
        self.line("");
        self.line("#[starpc::async_trait]");
        self.line(&format!(
            "impl<C: starpc::Client + 'static> {}Client for {}ClientImpl<C> {{",
            service_name, service_name
        ));

        // Implement each call using its wire identity and typed stream adapter.
        for method in self.service.methods.clone() {
            let method_name = &method.name;
            if method.client_streaming && method.server_streaming {
                self.line(&format!(
                    "    async fn {}(&self) -> starpc::Result<Box<dyn {}>> {{",
                    method_name,
                    stream_trait_name(&service_name, &method)
                ));
                self.line(&format!(
                    "        let stream = self.client.new_stream({:?}, {:?}, None).await?;",
                    service_id, method.proto_name
                ));
                self.line(&format!(
                    "        Ok(Box::new({}Impl {{ stream }}))",
                    stream_trait_name(&service_name, &method)
                ));
                self.line("    }");
            } else if method.server_streaming {
                self.line(&format!(
                    "    async fn {}(&self, request: &{}) -> starpc::Result<Box<dyn {}>> {{",
                    method_name,
                    method.input_type,
                    stream_trait_name(&service_name, &method)
                ));
                self.line("        use starpc::ProstMessage;");
                self.line("        let data = request.encode_to_vec();");
                self.line(&format!(
                    "        let stream = self.client.new_stream({:?}, {:?}, Some(&data)).await?;",
                    service_id, method.proto_name
                ));
                self.line(HALF_CLOSE_COMMENT);
                self.line("        let _ = stream.close_send().await;");
                self.line(&format!(
                    "        Ok(Box::new({}Impl {{ stream }}))",
                    stream_trait_name(&service_name, &method)
                ));
                self.line("    }");
            } else if method.client_streaming {
                self.line(&format!(
                    "    async fn {}(&self) -> starpc::Result<Box<dyn {}>> {{",
                    method_name,
                    stream_trait_name(&service_name, &method)
                ));
                self.line(&format!(
                    "        let stream = self.client.new_stream({:?}, {:?}, None).await?;",
                    service_id, method.proto_name
                ));
                self.line(&format!(
                    "        Ok(Box::new({}Impl {{ stream }}))",
                    stream_trait_name(&service_name, &method)
                ));
                self.line("    }");
            } else {
                self.line(&format!(
                    "    async fn {}(&self, request: &{}) -> starpc::Result<{}> {{",
                    method_name, method.input_type, method.output_type
                ));
                self.line(&format!(
                    "        self.client.exec_call({:?}, {:?}, request).await",
                    service_id, method.proto_name
                ));
                self.line("    }");
            }
        }
        self.line("}");
        self.line("");
    }

    /// Adapts each transport stream to its generated typed client contract.
    fn generate_stream_impls(&mut self) {
        // Adapt each streaming method through its retained transport stream.
        let service_name = self.service.name.clone();
        for method in self.service.methods.clone() {
            if !method.client_streaming && !method.server_streaming {
                continue;
            }

            // Name the typed stream and retain its common transport contract.
            let stream_trait = stream_trait_name(&service_name, &method);
            self.line(&format!("struct {}Impl {{", stream_trait));
            self.line("    stream: Box<dyn starpc::Stream>,");
            self.line("}");
            self.line("");
            self.line("#[starpc::async_trait]");
            self.line(&format!(
                "impl {} for {}Impl {{",
                stream_trait, stream_trait
            ));
            self.line("    fn context(&self) -> &starpc::Context {");
            self.line("        self.stream.context()");
            self.line("    }");

            // Provide typed sends when the caller owns the request stream.
            if method.client_streaming {
                self.line(&format!(
                    "    async fn send(&self, msg: &{}) -> starpc::Result<()> {{",
                    method.input_type
                ));
                self.line("        self.stream.msg_send(msg).await");
                self.line("    }");
            }

            // Provide typed receives when the server owns the response stream.
            if method.server_streaming {
                self.line(&format!(
                    "    async fn recv(&self) -> starpc::Result<{}> {{",
                    method.output_type
                ));
                self.line("        self.stream.msg_recv().await");
                self.line("    }");
            }

            // Preserve the final response after half-closing a request stream.
            if method.client_streaming && !method.server_streaming {
                self.line(&format!(
                    "    async fn close_and_recv(&self) -> starpc::Result<{}> {{",
                    method.output_type
                ));
                self.line(HALF_CLOSE_COMMENT);
                self.line("        let _ = self.stream.close_send().await;");
                self.line("        self.stream.msg_recv().await");
                self.line("    }");
            } else {
                self.line("    async fn close(&self) -> starpc::Result<()> {");
                self.line("        self.stream.close().await");
                self.line("    }");
            }
            self.line("}");
            self.line("");
        }
    }

    /// Declares the implementation contract consumed by handler dispatch.
    fn generate_server_trait(&mut self) {
        // Declare the implementation contract consumed by dispatch.
        let service_name = self.service.name.clone();
        self.line(&format!("/// Server trait for {}.", service_name));
        self.line("#[starpc::async_trait]");
        self.line(&format!("pub trait {}Server: Send + Sync {{", service_name));

        // Select each method signature from the descriptor streaming modes.
        for method in self.service.methods.clone() {
            self.line(&format!("    /// {}.", method.proto_name));
            if method.client_streaming && method.server_streaming {
                self.line(&format!(
                    "    async fn {}(&self, stream: Box<dyn starpc::Stream>) -> starpc::Result<()>;",
                    method.name
                ));
            } else if method.server_streaming {
                self.line(&format!(
                    "    async fn {}(&self, request: {}, stream: Box<dyn starpc::Stream>) -> starpc::Result<()>;",
                    method.name, method.input_type
                ));
            } else if method.client_streaming {
                self.line(&format!(
                    "    async fn {}(&self, stream: &dyn starpc::Stream) -> starpc::Result<{}>;",
                    method.name, method.output_type
                ));
            } else {
                self.line(&format!(
                    "    async fn {}(&self, request: {}) -> starpc::Result<{}>;",
                    method.name, method.input_type, method.output_type
                ));
            }
        }
        self.line("}");
        self.line("");
    }

    /// Routes wire method names through the exact server trait.
    fn generate_handler(&mut self) {
        // Retain empty services without emitting unused field or parameter names.
        let service_id = self.service_id();
        let service_name = self.service.name.clone();
        let methods = self.service.methods.clone();
        let method_ids = method_ids_const(&service_name);
        let (server_field, stream_parameter, method_parameter) = if methods.is_empty() {
            ("_server", "_stream", "_method_id")
        } else {
            ("server", "stream", "method_id")
        };

        // Emit the supported wire method identities.
        self.line(&format!("const {}: &[&str] = &[", method_ids));
        for method in &methods {
            self.line(&format!("    {:?},", method.proto_name));
        }
        self.line("];");
        self.line("");

        // Retain the server through both owned and shared construction.
        self.line(&format!("/// Handler for {}.", service_name));
        self.line(&format!(
            "pub struct {}Handler<S: {}Server> {{",
            service_name, service_name
        ));
        self.line(&format!("    {server_field}: std::sync::Arc<S>,"));
        self.line("}");
        self.line("");
        self.line(&format!(
            "impl<S: {}Server + 'static> {}Handler<S> {{",
            service_name, service_name
        ));
        self.line("    /// Creates a new handler wrapping the server implementation.");
        self.line("    pub fn new(server: S) -> Self {");
        self.line(&format!(
            "        Self {{ {server_field}: std::sync::Arc::new(server) }}"
        ));
        self.line("    }");
        self.line("");
        self.line("    /// Creates a new handler with a shared server.");
        self.line("    pub fn with_arc(server: std::sync::Arc<S>) -> Self {");
        if methods.is_empty() {
            self.line("        Self { _server: server }");
        } else {
            self.line("        Self { server }");
        }
        self.line("    }");
        self.line("}");
        self.line("");

        // Dispatch through the named trait so Arc methods cannot shadow RPCs.
        self.line("#[starpc::async_trait]");
        self.line(&format!(
            "impl<S: {}Server + 'static> starpc::Invoker for {}Handler<S> {{",
            service_name, service_name
        ));
        self.line("    async fn invoke_method(");
        self.line("        &self,");
        self.line("        _service_id: &str,");
        self.line(&format!("        {method_parameter}: &str,"));
        self.line(&format!(
            "        {stream_parameter}: Box<dyn starpc::Stream>,"
        ));
        self.line("    ) -> (bool, starpc::Result<()>) {");
        if methods.is_empty() {
            self.line("        (false, Err(starpc::Error::Unimplemented))");
        } else {
            self.line("        match method_id {");
        }

        // Receive and return the messages required by each RPC shape.
        for method in &methods {
            self.line(&format!("            {:?} => {{", method.proto_name));
            if method.client_streaming && method.server_streaming {
                self.line(&format!(
                    "                (true, <S as {}Server>::{}(self.server.as_ref(), stream).await)",
                    service_name, method.name
                ));
            } else if method.server_streaming {
                self.line(&format!(
                    "                let request: {} = match stream.msg_recv().await {{",
                    method.input_type
                ));
                self.line("                    Ok(r) => r,");
                self.line("                    Err(e) => return (true, Err(e)),");
                self.line("                };");
                self.line(&format!(
                    "                (true, <S as {}Server>::{}(self.server.as_ref(), request, stream).await)",
                    service_name, method.name
                ));
            } else if method.client_streaming {
                self.line(&format!(
                    "                match <S as {}Server>::{}(self.server.as_ref(), stream.as_ref()).await {{",
                    service_name, method.name
                ));
                self.line("                    Ok(response) => {");
                self.line(
                    "                        if let Err(e) = stream.msg_send(&response).await {",
                );
                self.line("                            return (true, Err(e));");
                self.line("                        }");
                self.line("                        (true, Ok(()))");
                self.line("                    }");
                self.line("                    Err(e) => (true, Err(e)),");
                self.line("                }");
            } else {
                self.line(&format!(
                    "                let request: {} = match stream.msg_recv().await {{",
                    method.input_type
                ));
                self.line("                    Ok(r) => r,");
                self.line("                    Err(e) => return (true, Err(e)),");
                self.line("                };");
                self.line(&format!(
                    "                match <S as {}Server>::{}(self.server.as_ref(), request).await {{",
                    service_name, method.name
                ));
                self.line("                    Ok(response) => {");
                self.line(
                    "                        if let Err(e) = stream.msg_send(&response).await {",
                );
                self.line("                            return (true, Err(e));");
                self.line("                        }");
                self.line("                        (true, Ok(()))");
                self.line("                    }");
                self.line("                    Err(e) => (true, Err(e)),");
                self.line("                }");
            }
            self.line("            }");
        }

        // Leave unknown wire methods available for another handler.
        if !methods.is_empty() {
            self.line("            _ => (false, Err(starpc::Error::Unimplemented)),");
            self.line("        }");
        }
        self.line("    }");
        self.line("}");
        self.line("");

        // Advertise the service and method identities used for routing.
        self.line(&format!(
            "impl<S: {}Server + 'static> starpc::Handler for {}Handler<S> {{",
            service_name, service_name
        ));
        self.line("    fn service_id(&self) -> &'static str {");
        self.line(&format!("        {:?}", service_id));
        self.line("    }");
        self.line("");
        self.line("    fn method_ids(&self) -> &'static [&'static str] {");
        self.line(&format!("        {}", method_ids));
        self.line("    }");
        self.line("}");
        self.line("");
    }

    /// Returns the fully qualified protobuf service identity used on the wire.
    fn service_id(&self) -> String {
        if self.service.package.is_empty() {
            self.service.proto_name.clone()
        } else {
            format!("{}.{}", self.service.package, self.service.proto_name)
        }
    }

    /// Appends one complete generated line to the package output.
    fn line(&mut self, line: &str) {
        self.buf.push_str(line);
        self.buf.push('\n');
    }
}

/// Formats the caller signature selected by a method's streaming modes.
fn client_trait_method(service_name: &str, method: &prost_build::Method) -> String {
    let stream_trait = stream_trait_name(service_name, method);
    if method.client_streaming && method.server_streaming {
        format!(
            "async fn {}(&self) -> starpc::Result<Box<dyn {}>>",
            method.name, stream_trait
        )
    } else if method.server_streaming {
        format!(
            "async fn {}(&self, request: &{}) -> starpc::Result<Box<dyn {}>>",
            method.name, method.input_type, stream_trait
        )
    } else if method.client_streaming {
        format!(
            "async fn {}(&self) -> starpc::Result<Box<dyn {}>>",
            method.name, stream_trait
        )
    } else {
        format!(
            "async fn {}(&self, request: &{}) -> starpc::Result<{}>",
            method.name, method.input_type, method.output_type
        )
    }
}

/// Names a stream within its service, avoiding collisions with other services.
fn stream_trait_name(service_name: &str, method: &prost_build::Method) -> String {
    format!(
        "{}{}Stream",
        service_name,
        upper_camel_from_snake(&method.name)
    )
}

/// Names the public wire-service identity constant.
fn service_id_const(service_name: &str) -> String {
    format!("{}_SERVICE_ID", screaming_snake(service_name))
}

/// Names the handler's supported-method list.
fn method_ids_const(service_name: &str) -> String {
    format!("{}_METHOD_IDS", screaming_snake(service_name))
}

/// Separates uppercase transitions using the existing generated naming contract.
fn screaming_snake(name: &str) -> String {
    let mut out = String::new();
    for (idx, ch) in name.chars().enumerate() {
        if ch.is_uppercase() && idx != 0 {
            out.push('_');
        }
        out.extend(ch.to_uppercase());
    }
    out
}

/// Converts a Prost method identifier into the stream type's name segment.
fn upper_camel_from_snake(name: &str) -> String {
    let mut out = String::new();
    let mut upper = true;
    for ch in name.chars() {
        if ch == '_' {
            upper = true;
            continue;
        }
        if upper {
            out.extend(ch.to_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

/// Checks generated API shape and half-close failure handling.
#[cfg(test)]
mod tests {
    use std::fs;

    /// Keeps every RPC shape and preserves responses after a failed half-close.
    #[test]
    fn configure_generates_starpc_service_glue() {
        // Isolate generated sources from other generator runs.
        let root = std::env::temp_dir().join(format!(
            "starpc-codegen-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let proto_dir = root.join("proto");
        let out_dir = root.join("out");
        fs::create_dir_all(&proto_dir).unwrap();
        fs::create_dir_all(&out_dir).unwrap();

        // Exercise all call shapes in one service declaration.
        let proto = proto_dir.join("test.proto");
        fs::write(
            &proto,
            r#"syntax = "proto3";
package fixture;

service TestService {
  rpc Unary(TestMsg) returns (TestMsg);
  rpc ServerStream(TestMsg) returns (stream TestMsg);
  rpc ClientStream(stream TestMsg) returns (TestMsg);
  rpc Bidi(stream TestMsg) returns (stream TestMsg);
}

message TestMsg {
  string body = 1;
}
"#,
        )
        .unwrap();

        // Generate the real bindings and check their public surfaces.
        let mut config = super::configure();
        config.out_dir(&out_dir);
        config.compile_protos(&[proto], &[proto_dir]).unwrap();

        // Verify the externally consumed client, server, and stream names.
        let generated = fs::read_to_string(out_dir.join("fixture.rs")).unwrap();
        assert!(generated.contains("pub const TEST_SERVICE_SERVICE_ID"));
        assert!(generated.contains("pub trait TestServiceClient"));
        assert!(generated.contains("pub struct TestServiceClientImpl"));
        assert!(generated.contains("pub trait TestServiceServer"));
        assert!(generated.contains("pub struct TestServiceHandler"));
        assert!(generated.contains("TestServiceServerStreamStream"));
        assert!(generated.contains("TestServiceClientStreamStream"));
        assert!(generated.contains("TestServiceBidiStream"));

        // A failed half-close must not discard the stream; msg_recv reports
        // the call's outcome.
        assert!(!generated.contains("close_send().await?"));
        assert!(generated.contains("let _ = stream.close_send().await;"));
        assert!(generated.contains("let _ = self.stream.close_send().await;"));

        // Release the disposable generated sources after checking their contract.
        fs::remove_dir_all(&root).unwrap();
    }
}
