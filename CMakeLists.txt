cmake_minimum_required(VERSION 3.24)
project(starpc LANGUAGES CXX)

if(NOT DEFINED CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 20)
endif()

# Embedded builds reuse their protobuf runtime and do not add test executables.
option(STARPC_BUILD_TESTS "Build starpc tests" ${PROJECT_IS_TOP_LEVEL})
option(STARPC_BUILD_EXAMPLES "Build starpc examples" ${PROJECT_IS_TOP_LEVEL})
option(STARPC_USE_SYSTEM_PROTOBUF "Use an installed protobuf runtime" OFF)

find_package(Threads REQUIRED)
if(NOT TARGET protobuf::libprotobuf)
  if(STARPC_USE_SYSTEM_PROTOBUF)
    find_package(Protobuf CONFIG REQUIRED)
  else()
    set(STARPC_VENDOR_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vendor/github.com/aperturerobotics)
    set(ABSL_PROPAGATE_CXX_STD ON CACHE BOOL "" FORCE)
    set(ABSL_BUILD_TESTING OFF CACHE BOOL "" FORCE)
    set(ABSL_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
    if(NOT TARGET absl::base)
      add_subdirectory(${STARPC_VENDOR_DIR}/abseil-cpp ${CMAKE_CURRENT_BINARY_DIR}/abseil-cpp EXCLUDE_FROM_ALL)
    endif()
    set(protobuf_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(protobuf_BUILD_CONFORMANCE OFF CACHE BOOL "" FORCE)
    set(protobuf_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(protobuf_BUILD_PROTOC_BINARIES OFF CACHE BOOL "" FORCE)
    set(protobuf_BUILD_LIBPROTOC OFF CACHE BOOL "" FORCE)
    set(protobuf_BUILD_LIBUPB OFF CACHE BOOL "" FORCE)
    set(protobuf_INSTALL OFF CACHE BOOL "" FORCE)
    set(protobuf_ABSL_PROVIDER "package" CACHE STRING "" FORCE)
    add_subdirectory(${STARPC_VENDOR_DIR}/protobuf ${CMAKE_CURRENT_BINARY_DIR}/protobuf EXCLUDE_FROM_ALL)
  endif()
endif()


add_library(starpc
  srpc/packet.cpp
  srpc/common-rpc.cpp
  srpc/client-rpc.cpp
  srpc/server-rpc.cpp
  srpc/mux.cpp
  srpc/client.cpp
  srpc/rpcproto.pb.cc
  rpcstream/rpcstream.cpp
  rpcstream/rpcstream.pb.cc
)
add_library(starpc::starpc ALIAS starpc)
target_compile_features(starpc PUBLIC cxx_std_20)
set_target_properties(starpc PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(starpc PUBLIC ${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/vendor)
target_link_libraries(starpc PUBLIC protobuf::libprotobuf Threads::Threads)

install(TARGETS starpc ARCHIVE DESTINATION lib LIBRARY DESTINATION lib RUNTIME DESTINATION bin)
install(DIRECTORY srpc rpcstream DESTINATION include
  FILES_MATCHING PATTERN "*.hpp" PATTERN "*.pb.h")

if(STARPC_BUILD_EXAMPLES OR STARPC_BUILD_TESTS)
  add_library(echo_proto echo/echo.pb.cc echo/echo_srpc.pb.cpp)
  target_include_directories(echo_proto PUBLIC ${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/vendor)
  target_link_libraries(echo_proto PUBLIC starpc)
endif()

if(STARPC_BUILD_TESTS)
  enable_testing()
  add_executable(echo_e2e_test echo/echo_e2e_test.cpp)
  target_link_libraries(echo_e2e_test PRIVATE echo_proto)
  add_test(NAME echo_e2e_test COMMAND echo_e2e_test)
  set_tests_properties(echo_e2e_test PROPERTIES TIMEOUT 30)

  add_executable(rpc_lifecycle_test srpc/rpc_lifecycle_test.cc)
  target_link_libraries(rpc_lifecycle_test PRIVATE echo_proto)
  add_test(NAME rpc_lifecycle_test COMMAND rpc_lifecycle_test)
  set_tests_properties(rpc_lifecycle_test PROPERTIES TIMEOUT 30)

  add_executable(cpp-pipe-server integration/cross-language/cpp-pipe-server.cpp)
  target_link_libraries(cpp-pipe-server PRIVATE echo_proto)
  find_program(STARPC_GO_EXECUTABLE go)
  if(STARPC_GO_EXECUTABLE)
    add_test(NAME go_cpp_process_pipe
      COMMAND ${CMAKE_COMMAND} -E env STARPC_CPP_PIPE_SERVER=$<TARGET_FILE:cpp-pipe-server>
        ${STARPC_GO_EXECUTABLE} test -timeout=30s -run=TestCppProcessPipe ./integration/cross-language)
    set_tests_properties(go_cpp_process_pipe PROPERTIES WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR} TIMEOUT 60)
  endif()
endif()

if((STARPC_BUILD_EXAMPLES OR STARPC_BUILD_TESTS) AND UNIX)
  foreach(role server client)
    add_executable(cpp-integration-${role} integration/cross-language/cpp-${role}.cpp)
    target_link_libraries(cpp-integration-${role} PRIVATE echo_proto)
  endforeach()
endif()
