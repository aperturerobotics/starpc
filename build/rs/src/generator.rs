//! Service generator for starpc.

use prost_build::{Service, ServiceGenerator};
use std::fmt::Write;

/// Service generator that produces starpc client and server code.
pub struct StarpcServiceGenerator {
    /// Whether to generate client code.
    generate_client: bool,
    /// Whether to generate server code.
    generate_server: bool,
}

impl Default for StarpcServiceGenerator {
    fn default() -> Self {
        Self::new()
    }
}

impl StarpcServiceGenerator {
    /// Creates a new service generator with default settings.
    pub fn new() -> Self {
        Self {
            generate_client: true,
            generate_server: true,
        }
    }

    /// Sets whether to generate client code.
    pub fn client(mut self, generate: bool) -> Self {
        self.generate_client = generate;
        self
    }

    /// Sets whether to generate server code.
    pub fn server(mut self, generate: bool) -> Self {
        self.generate_server = generate;
        self
    }

    fn generate_service_id(&self, buf: &mut String, service: &Service) {
        // Handle empty package: use just the proto_name without leading dot.
        let service_id = if service.package.is_empty() {
            service.proto_name.clone()
        } else {
            format!("{}.{}", service.package, service.proto_name)
        };
        writeln!(buf, "/// Service ID for {}.", service.proto_name).unwrap();
        writeln!(
            buf,
            "pub const {}_SERVICE_ID: &str = \"{}\";",
            to_screaming_snake_case(&service.proto_name),
            service_id
        )
        .unwrap();
        writeln!(buf).unwrap();
    }

    fn generate_client_trait(&self, buf: &mut String, service: &Service) {
        // Generate client trait.
        writeln!(buf, "/// Client trait for {}.", service.proto_name).unwrap();
        writeln!(buf, "#[starpc::async_trait]").unwrap();
        writeln!(
            buf,
            "pub trait {}Client: Send + Sync {{",
            service.proto_name
        )
        .unwrap();

        for method in &service.methods {
            let input_type = &method.input_type;
            let output_type = &method.output_type;

            writeln!(buf, "    /// {}.", method.proto_name).unwrap();
            for line in method.comments.leading.iter() {
                writeln!(buf, "    /// {}", line.trim()).unwrap();
            }

            if method.client_streaming && method.server_streaming {
                // Bidirectional streaming.
                writeln!(
                    buf,
                    "    async fn {}(&self) -> starpc::Result<Box<dyn {}{}Stream>>;",
                    to_snake_case(&method.proto_name),
                    service.proto_name,
                    method.proto_name
                )
                .unwrap();
            } else if method.server_streaming {
                // Server streaming.
                writeln!(
                    buf,
                    "    async fn {}(&self, request: &{}) -> starpc::Result<Box<dyn {}{}Stream>>;",
                    to_snake_case(&method.proto_name),
                    input_type,
                    service.proto_name,
                    method.proto_name
                )
                .unwrap();
            } else if method.client_streaming {
                // Client streaming.
                writeln!(
                    buf,
                    "    async fn {}(&self) -> starpc::Result<Box<dyn {}{}Stream>>;",
                    to_snake_case(&method.proto_name),
                    service.proto_name,
                    method.proto_name
                )
                .unwrap();
            } else {
                // Unary.
                writeln!(
                    buf,
                    "    async fn {}(&self, request: &{}) -> starpc::Result<{}>;",
                    to_snake_case(&method.proto_name),
                    input_type,
                    output_type
                )
                .unwrap();
            }
        }

        writeln!(buf, "}}").unwrap();
        writeln!(buf).unwrap();
    }

    fn generate_stream_traits(&self, buf: &mut String, service: &Service) {
        for method in &service.methods {
            if !method.client_streaming && !method.server_streaming {
                continue;
            }

            let input_type = &method.input_type;
            let output_type = &method.output_type;

            writeln!(
                buf,
                "/// Stream trait for {}.{}.",
                service.proto_name, method.proto_name
            )
            .unwrap();
            writeln!(buf, "#[starpc::async_trait]").unwrap();
            writeln!(
                buf,
                "pub trait {}{}Stream: Send + Sync {{",
                service.proto_name, method.proto_name
            )
            .unwrap();

            // Always provide context.
            writeln!(buf, "    /// Returns the context for this stream.").unwrap();
            writeln!(buf, "    fn context(&self) -> &starpc::Context;").unwrap();

            if method.client_streaming {
                writeln!(buf, "    /// Sends a message on the stream.").unwrap();
                writeln!(
                    buf,
                    "    async fn send(&self, msg: &{}) -> starpc::Result<()>;",
                    input_type
                )
                .unwrap();
            }

            if method.server_streaming {
                writeln!(buf, "    /// Receives a message from the stream.").unwrap();
                writeln!(
                    buf,
                    "    async fn recv(&self) -> starpc::Result<{}>;",
                    output_type
                )
                .unwrap();
            }

            if method.client_streaming && !method.server_streaming {
                // Client streaming - need close_and_recv for the final response.
                writeln!(
                    buf,
                    "    /// Closes the send side and receives the response."
                )
                .unwrap();
                writeln!(
                    buf,
                    "    async fn close_and_recv(&self) -> starpc::Result<{}>;",
                    output_type
                )
                .unwrap();
            } else {
                writeln!(buf, "    /// Closes the stream.").unwrap();
                writeln!(buf, "    async fn close(&self) -> starpc::Result<()>;").unwrap();
            }

            writeln!(buf, "}}").unwrap();
            writeln!(buf).unwrap();
        }
    }

    fn generate_client_impl(&self, buf: &mut String, service: &Service) {
        // Handle empty package: use just the proto_name without leading dot.
        let service_id = if service.package.is_empty() {
            service.proto_name.clone()
        } else {
            format!("{}.{}", service.package, service.proto_name)
        };

        // Generate client implementation struct.
        writeln!(buf, "/// Client implementation for {}.", service.proto_name).unwrap();
        writeln!(buf, "pub struct {}ClientImpl<C> {{", service.proto_name).unwrap();
        writeln!(buf, "    client: C,").unwrap();
        writeln!(buf, "}}").unwrap();
        writeln!(buf).unwrap();

        writeln!(
            buf,
            "impl<C: starpc::Client> {}ClientImpl<C> {{",
            service.proto_name
        )
        .unwrap();
        writeln!(buf, "    /// Creates a new client.").unwrap();
        writeln!(buf, "    pub fn new(client: C) -> Self {{").unwrap();
        writeln!(buf, "        Self {{ client }}").unwrap();
        writeln!(buf, "    }}").unwrap();
        writeln!(buf, "}}").unwrap();
        writeln!(buf).unwrap();

        // Implement the client trait.
        writeln!(buf, "#[starpc::async_trait]").unwrap();
        writeln!(
            buf,
            "impl<C: starpc::Client + 'static> {}Client for {}ClientImpl<C> {{",
            service.proto_name, service.proto_name
        )
        .unwrap();

        for method in &service.methods {
            let input_type = &method.input_type;
            let output_type = &method.output_type;
            let method_name = to_snake_case(&method.proto_name);

            if method.client_streaming && method.server_streaming {
                // Bidirectional streaming.
                writeln!(
                    buf,
                    "    async fn {}(&self) -> starpc::Result<Box<dyn {}{}Stream>> {{",
                    method_name, service.proto_name, method.proto_name
                )
                .unwrap();
                writeln!(
                    buf,
                    "        let stream = self.client.new_stream(\"{}\", \"{}\", None).await?;",
                    service_id, method.proto_name
                )
                .unwrap();
                writeln!(
                    buf,
                    "        Ok(Box::new({}{}StreamImpl {{ stream }}))",
                    service.proto_name, method.proto_name
                )
                .unwrap();
                writeln!(buf, "    }}").unwrap();
            } else if method.server_streaming {
                // Server streaming.
                writeln!(
                    buf,
                    "    async fn {}(&self, request: &{}) -> starpc::Result<Box<dyn {}{}Stream>> {{",
                    method_name,
                    input_type,
                    service.proto_name,
                    method.proto_name
                ).unwrap();
                writeln!(buf, "        use starpc::ProstMessage;").unwrap();
                writeln!(buf, "        let data = request.encode_to_vec();").unwrap();
                writeln!(
                    buf,
                    "        let stream = self.client.new_stream(\"{}\", \"{}\", Some(&data)).await?;",
                    service_id,
                    method.proto_name
                ).unwrap();
                writeln!(buf, "        stream.close_send().await?;").unwrap();
                writeln!(
                    buf,
                    "        Ok(Box::new({}{}StreamImpl {{ stream }}))",
                    service.proto_name, method.proto_name
                )
                .unwrap();
                writeln!(buf, "    }}").unwrap();
            } else if method.client_streaming {
                // Client streaming.
                writeln!(
                    buf,
                    "    async fn {}(&self) -> starpc::Result<Box<dyn {}{}Stream>> {{",
                    method_name, service.proto_name, method.proto_name
                )
                .unwrap();
                writeln!(
                    buf,
                    "        let stream = self.client.new_stream(\"{}\", \"{}\", None).await?;",
                    service_id, method.proto_name
                )
                .unwrap();
                writeln!(
                    buf,
                    "        Ok(Box::new({}{}StreamImpl {{ stream }}))",
                    service.proto_name, method.proto_name
                )
                .unwrap();
                writeln!(buf, "    }}").unwrap();
            } else {
                // Unary.
                writeln!(
                    buf,
                    "    async fn {}(&self, request: &{}) -> starpc::Result<{}> {{",
                    method_name, input_type, output_type
                )
                .unwrap();
                writeln!(
                    buf,
                    "        self.client.exec_call(\"{}\", \"{}\", request).await",
                    service_id, method.proto_name
                )
                .unwrap();
                writeln!(buf, "    }}").unwrap();
            }
        }

        writeln!(buf, "}}").unwrap();
        writeln!(buf).unwrap();

        // Generate stream implementations.
        self.generate_stream_impls(buf, service);
    }

    fn generate_stream_impls(&self, buf: &mut String, service: &Service) {
        for method in &service.methods {
            if !method.client_streaming && !method.server_streaming {
                continue;
            }

            let input_type = &method.input_type;
            let output_type = &method.output_type;

            writeln!(
                buf,
                "struct {}{}StreamImpl {{",
                service.proto_name, method.proto_name
            )
            .unwrap();
            writeln!(buf, "    stream: Box<dyn starpc::Stream>,").unwrap();
            writeln!(buf, "}}").unwrap();
            writeln!(buf).unwrap();

            writeln!(buf, "#[starpc::async_trait]").unwrap();
            writeln!(
                buf,
                "impl {}{}Stream for {}{}StreamImpl {{",
                service.proto_name, method.proto_name, service.proto_name, method.proto_name
            )
            .unwrap();

            writeln!(buf, "    fn context(&self) -> &starpc::Context {{").unwrap();
            writeln!(buf, "        self.stream.context()").unwrap();
            writeln!(buf, "    }}").unwrap();

            if method.client_streaming {
                writeln!(
                    buf,
                    "    async fn send(&self, msg: &{}) -> starpc::Result<()> {{",
                    input_type
                )
                .unwrap();
                writeln!(buf, "        self.stream.msg_send(msg).await").unwrap();
                writeln!(buf, "    }}").unwrap();
            }

            if method.server_streaming {
                writeln!(
                    buf,
                    "    async fn recv(&self) -> starpc::Result<{}> {{",
                    output_type
                )
                .unwrap();
                writeln!(buf, "        self.stream.msg_recv().await").unwrap();
                writeln!(buf, "    }}").unwrap();
            }

            if method.client_streaming && !method.server_streaming {
                writeln!(
                    buf,
                    "    async fn close_and_recv(&self) -> starpc::Result<{}> {{",
                    output_type
                )
                .unwrap();
                writeln!(buf, "        self.stream.close_send().await?;").unwrap();
                writeln!(buf, "        self.stream.msg_recv().await").unwrap();
                writeln!(buf, "    }}").unwrap();
            } else {
                writeln!(buf, "    async fn close(&self) -> starpc::Result<()> {{").unwrap();
                writeln!(buf, "        self.stream.close().await").unwrap();
                writeln!(buf, "    }}").unwrap();
            }

            writeln!(buf, "}}").unwrap();
            writeln!(buf).unwrap();
        }
    }

    fn generate_server_trait(&self, buf: &mut String, service: &Service) {
        writeln!(buf, "/// Server trait for {}.", service.proto_name).unwrap();
        writeln!(buf, "#[starpc::async_trait]").unwrap();
        writeln!(
            buf,
            "pub trait {}Server: Send + Sync {{",
            service.proto_name
        )
        .unwrap();

        for method in &service.methods {
            let input_type = &method.input_type;
            let output_type = &method.output_type;

            writeln!(buf, "    /// {}.", method.proto_name).unwrap();
            for line in method.comments.leading.iter() {
                writeln!(buf, "    /// {}", line.trim()).unwrap();
            }

            if method.client_streaming && method.server_streaming {
                // Bidirectional streaming.
                writeln!(
                    buf,
                    "    async fn {}(&self, stream: Box<dyn starpc::Stream>) -> starpc::Result<()>;",
                    to_snake_case(&method.proto_name)
                ).unwrap();
            } else if method.server_streaming {
                // Server streaming.
                writeln!(
                    buf,
                    "    async fn {}(&self, request: {}, stream: Box<dyn starpc::Stream>) -> starpc::Result<()>;",
                    to_snake_case(&method.proto_name),
                    input_type
                ).unwrap();
            } else if method.client_streaming {
                // Client streaming.
                writeln!(
                    buf,
                    "    async fn {}(&self, stream: &dyn starpc::Stream) -> starpc::Result<{}>;",
                    to_snake_case(&method.proto_name),
                    output_type
                )
                .unwrap();
            } else {
                // Unary.
                writeln!(
                    buf,
                    "    async fn {}(&self, request: {}) -> starpc::Result<{}>;",
                    to_snake_case(&method.proto_name),
                    input_type,
                    output_type
                )
                .unwrap();
            }
        }

        writeln!(buf, "}}").unwrap();
        writeln!(buf).unwrap();
    }

    fn generate_handler(&self, buf: &mut String, service: &Service) {
        // Handle empty package: use just the proto_name without leading dot.
        let service_id = if service.package.is_empty() {
            service.proto_name.clone()
        } else {
            format!("{}.{}", service.package, service.proto_name)
        };

        // Generate method IDs constant.
        writeln!(
            buf,
            "const {}_METHOD_IDS: &[&str] = &[",
            to_screaming_snake_case(&service.proto_name)
        )
        .unwrap();
        for method in &service.methods {
            writeln!(buf, "    \"{}\",", method.proto_name).unwrap();
        }
        writeln!(buf, "];").unwrap();
        writeln!(buf).unwrap();

        // Generate handler struct.
        writeln!(buf, "/// Handler for {}.", service.proto_name).unwrap();
        writeln!(
            buf,
            "pub struct {}Handler<S: {}Server> {{",
            service.proto_name, service.proto_name
        )
        .unwrap();
        writeln!(buf, "    server: std::sync::Arc<S>,").unwrap();
        writeln!(buf, "}}").unwrap();
        writeln!(buf).unwrap();

        writeln!(
            buf,
            "impl<S: {}Server + 'static> {}Handler<S> {{",
            service.proto_name, service.proto_name
        )
        .unwrap();
        writeln!(
            buf,
            "    /// Creates a new handler wrapping the server implementation."
        )
        .unwrap();
        writeln!(buf, "    pub fn new(server: S) -> Self {{").unwrap();
        writeln!(
            buf,
            "        Self {{ server: std::sync::Arc::new(server) }}"
        )
        .unwrap();
        writeln!(buf, "    }}").unwrap();
        writeln!(buf).unwrap();
        writeln!(buf, "    /// Creates a new handler with a shared server.").unwrap();
        writeln!(
            buf,
            "    pub fn with_arc(server: std::sync::Arc<S>) -> Self {{"
        )
        .unwrap();
        writeln!(buf, "        Self {{ server }}").unwrap();
        writeln!(buf, "    }}").unwrap();
        writeln!(buf, "}}").unwrap();
        writeln!(buf).unwrap();

        // Implement Invoker.
        writeln!(buf, "#[starpc::async_trait]").unwrap();
        writeln!(
            buf,
            "impl<S: {}Server + 'static> starpc::Invoker for {}Handler<S> {{",
            service.proto_name, service.proto_name
        )
        .unwrap();
        writeln!(buf, "    async fn invoke_method(").unwrap();
        writeln!(buf, "        &self,").unwrap();
        writeln!(buf, "        _service_id: &str,").unwrap();
        writeln!(buf, "        method_id: &str,").unwrap();
        writeln!(buf, "        stream: Box<dyn starpc::Stream>,").unwrap();
        writeln!(buf, "    ) -> (bool, starpc::Result<()>) {{").unwrap();
        writeln!(buf, "        match method_id {{").unwrap();

        for method in &service.methods {
            let input_type = &method.input_type;
            let method_name = to_snake_case(&method.proto_name);

            writeln!(buf, "            \"{}\" => {{", method.proto_name).unwrap();

            if method.client_streaming && method.server_streaming {
                // Bidirectional streaming.
                writeln!(
                    buf,
                    "                (true, self.server.{}(stream).await)",
                    method_name
                )
                .unwrap();
            } else if method.server_streaming {
                // Server streaming - receive request first.
                writeln!(
                    buf,
                    "                let request: {} = match stream.msg_recv().await {{",
                    input_type
                )
                .unwrap();
                writeln!(buf, "                    Ok(r) => r,").unwrap();
                writeln!(buf, "                    Err(e) => return (true, Err(e)),").unwrap();
                writeln!(buf, "                }};").unwrap();
                writeln!(
                    buf,
                    "                (true, self.server.{}(request, stream).await)",
                    method_name
                )
                .unwrap();
            } else if method.client_streaming {
                // Client streaming - receive messages, then send response.
                writeln!(
                    buf,
                    "                match self.server.{}(stream.as_ref()).await {{",
                    method_name
                )
                .unwrap();
                writeln!(buf, "                    Ok(response) => {{").unwrap();
                writeln!(
                    buf,
                    "                        if let Err(e) = stream.msg_send(&response).await {{"
                )
                .unwrap();
                writeln!(buf, "                            return (true, Err(e));").unwrap();
                writeln!(buf, "                        }}").unwrap();
                writeln!(buf, "                        (true, Ok(()))").unwrap();
                writeln!(buf, "                    }}").unwrap();
                writeln!(buf, "                    Err(e) => (true, Err(e)),").unwrap();
                writeln!(buf, "                }}").unwrap();
            } else {
                // Unary.
                writeln!(
                    buf,
                    "                let request: {} = match stream.msg_recv().await {{",
                    input_type
                )
                .unwrap();
                writeln!(buf, "                    Ok(r) => r,").unwrap();
                writeln!(buf, "                    Err(e) => return (true, Err(e)),").unwrap();
                writeln!(buf, "                }};").unwrap();
                writeln!(
                    buf,
                    "                match self.server.{}(request).await {{",
                    method_name
                )
                .unwrap();
                writeln!(buf, "                    Ok(response) => {{").unwrap();
                writeln!(
                    buf,
                    "                        if let Err(e) = stream.msg_send(&response).await {{"
                )
                .unwrap();
                writeln!(buf, "                            return (true, Err(e));").unwrap();
                writeln!(buf, "                        }}").unwrap();
                writeln!(buf, "                        (true, Ok(()))").unwrap();
                writeln!(buf, "                    }}").unwrap();
                writeln!(buf, "                    Err(e) => (true, Err(e)),").unwrap();
                writeln!(buf, "                }}").unwrap();
            }

            writeln!(buf, "            }}").unwrap();
        }

        writeln!(
            buf,
            "            _ => (false, Err(starpc::Error::Unimplemented)),"
        )
        .unwrap();
        writeln!(buf, "        }}").unwrap();
        writeln!(buf, "    }}").unwrap();
        writeln!(buf, "}}").unwrap();
        writeln!(buf).unwrap();

        // Implement Handler.
        writeln!(
            buf,
            "impl<S: {}Server + 'static> starpc::Handler for {}Handler<S> {{",
            service.proto_name, service.proto_name
        )
        .unwrap();
        writeln!(buf, "    fn service_id(&self) -> &'static str {{").unwrap();
        writeln!(buf, "        \"{}\"", service_id).unwrap();
        writeln!(buf, "    }}").unwrap();
        writeln!(buf).unwrap();
        writeln!(
            buf,
            "    fn method_ids(&self) -> &'static [&'static str] {{"
        )
        .unwrap();
        writeln!(
            buf,
            "        {}_METHOD_IDS",
            to_screaming_snake_case(&service.proto_name)
        )
        .unwrap();
        writeln!(buf, "    }}").unwrap();
        writeln!(buf, "}}").unwrap();
        writeln!(buf).unwrap();
    }
}

impl ServiceGenerator for StarpcServiceGenerator {
    fn generate(&mut self, service: Service, buf: &mut String) {
        // Import StreamExt for msg_send/msg_recv methods.
        // Allow unused in case no streaming methods use it.
        writeln!(buf, "#[allow(unused_imports)]").unwrap();
        writeln!(buf, "use starpc::StreamExt;").unwrap();
        writeln!(buf).unwrap();

        // Generate service ID constant.
        self.generate_service_id(buf, &service);

        if self.generate_client {
            self.generate_stream_traits(buf, &service);
            self.generate_client_trait(buf, &service);
            self.generate_client_impl(buf, &service);
        }

        if self.generate_server {
            self.generate_server_trait(buf, &service);
            self.generate_handler(buf, &service);
        }
    }
}

/// Converts a PascalCase name to snake_case.
fn to_snake_case(s: &str) -> String {
    let mut result = String::new();
    for (i, c) in s.chars().enumerate() {
        if c.is_uppercase() {
            if i > 0 {
                result.push('_');
            }
            result.push(c.to_ascii_lowercase());
        } else {
            result.push(c);
        }
    }
    result
}

/// Converts a name to SCREAMING_SNAKE_CASE.
fn to_screaming_snake_case(s: &str) -> String {
    let mut result = String::new();
    for (i, c) in s.chars().enumerate() {
        if c.is_uppercase() {
            if i > 0 {
                result.push('_');
            }
            result.push(c);
        } else {
            result.push(c.to_ascii_uppercase());
        }
    }
    result
}
