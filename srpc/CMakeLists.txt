cmake_minimum_required(VERSION 3.14)

# C++ starpc library
# This builds the core srpc library

set(STARPC_SOURCES
    packet.cpp
    common-rpc.cpp
    client-rpc.cpp
    server-rpc.cpp
    mux.cpp
    client.cpp
    rpcproto.pb.cc
)

set(STARPC_HEADERS
    starpc.hpp
    errors.hpp
    message.hpp
    writer.hpp
    packet.hpp
    stream.hpp
    msg-stream.hpp
    common-rpc.hpp
    client-rpc.hpp
    server-rpc.hpp
    invoker.hpp
    handler.hpp
    mux.hpp
    client.hpp
    rpcproto.pb.h
)

add_library(starpc ${STARPC_SOURCES})

target_include_directories(starpc PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/..
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_compile_features(starpc PUBLIC cxx_std_17)

# Link protobuf
find_package(Protobuf REQUIRED)
target_link_libraries(starpc PUBLIC protobuf::libprotobuf)

# Link threads
find_package(Threads REQUIRED)
target_link_libraries(starpc PUBLIC Threads::Threads)

# Install targets
install(TARGETS starpc
    ARCHIVE DESTINATION lib
    LIBRARY DESTINATION lib
)

install(FILES ${STARPC_HEADERS}
    DESTINATION include/srpc
)
