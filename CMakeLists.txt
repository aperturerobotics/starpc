cmake_minimum_required(VERSION 3.16)
project(starpc VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Options
option(STARPC_BUILD_TESTS "Build starpc tests" ON)
option(STARPC_BUILD_EXAMPLES "Build starpc examples" ON)

# Find Threads (always available on most systems)
find_package(Threads REQUIRED)

# Set variables for vendored dependencies
set(VENDOR_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vendor/github.com/aperturerobotics)
set(ABSEIL_DIR ${VENDOR_DIR}/abseil-cpp)
set(PROTOBUF_DIR ${VENDOR_DIR}/protobuf)

# Configure abseil options before add_subdirectory
set(ABSL_PROPAGATE_CXX_STD ON CACHE BOOL "" FORCE)
set(ABSL_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(ABSL_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)

# Add abseil-cpp from vendored sources
add_subdirectory(${ABSEIL_DIR} ${CMAKE_BINARY_DIR}/abseil-cpp EXCLUDE_FROM_ALL)

# Configure protobuf options before add_subdirectory
set(protobuf_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(protobuf_BUILD_CONFORMANCE OFF CACHE BOOL "" FORCE)
set(protobuf_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(protobuf_BUILD_PROTOC_BINARIES OFF CACHE BOOL "" FORCE)
set(protobuf_BUILD_LIBPROTOC OFF CACHE BOOL "" FORCE)
set(protobuf_BUILD_LIBUPB OFF CACHE BOOL "" FORCE)
set(protobuf_INSTALL OFF CACHE BOOL "" FORCE)
set(protobuf_ABSL_PROVIDER "package" CACHE STRING "" FORCE)

# Add protobuf from vendored sources
add_subdirectory(${PROTOBUF_DIR} ${CMAKE_BINARY_DIR}/protobuf EXCLUDE_FROM_ALL)

# Include paths for vendored dependencies and Go-style imports
include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/vendor
    ${PROTOBUF_DIR}/src
    ${PROTOBUF_DIR}/third_party/utf8_range
    ${ABSEIL_DIR}
)

# Core starpc library sources
set(STARPC_SOURCES
    srpc/packet.cpp
    srpc/common-rpc.cpp
    srpc/client-rpc.cpp
    srpc/server-rpc.cpp
    srpc/mux.cpp
    srpc/client.cpp
)

# Generated protobuf sources
set(STARPC_PROTO_SOURCES
    srpc/rpcproto.pb.cc
)

# Create the library
add_library(starpc ${STARPC_SOURCES} ${STARPC_PROTO_SOURCES})

target_include_directories(starpc PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/vendor
    ${PROTOBUF_DIR}/src
)

target_link_libraries(starpc PUBLIC
    libprotobuf
    Threads::Threads
)

# Echo example library (protobuf messages)
if(STARPC_BUILD_EXAMPLES OR STARPC_BUILD_TESTS)
    set(ECHO_PROTO_SOURCES
        echo/echo.pb.cc
        rpcstream/rpcstream.pb.cc
    )

    add_library(echo_proto ${ECHO_PROTO_SOURCES})
    target_include_directories(echo_proto PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}/vendor
        ${PROTOBUF_DIR}/src
    )
    target_link_libraries(echo_proto PUBLIC libprotobuf)
endif()

# Tests
if(STARPC_BUILD_TESTS)
    enable_testing()

    # Echo E2E test executable
    add_executable(echo_e2e_test
        echo/echo_e2e_test.cpp
        echo/echo_srpc.pb.cpp
    )

    target_link_libraries(echo_e2e_test PRIVATE
        starpc
        echo_proto
    )

    add_test(NAME echo_e2e_test COMMAND echo_e2e_test)
endif()

# Install targets
install(TARGETS starpc
    ARCHIVE DESTINATION lib
    LIBRARY DESTINATION lib
    RUNTIME DESTINATION bin
)

install(DIRECTORY srpc/
    DESTINATION include/srpc
    FILES_MATCHING PATTERN "*.hpp"
)
