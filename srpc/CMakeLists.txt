cmake_minimum_required(VERSION 3.24)

# Keep the historical subdirectory entry point on the same complete target.
add_subdirectory(${CMAKE_CURRENT_LIST_DIR}/.. ${CMAKE_CURRENT_BINARY_DIR}/starpc)
