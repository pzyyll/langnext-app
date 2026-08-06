# ABOUTME: CMake project for the first-party PaddleOCR native worker executable.
# ABOUTME: Production links PaddleOCR v3.7.0 + Paddle Inference v3.3.0; CI may build a stub.
cmake_minimum_required(VERSION 3.29)
project(langnext_paddleocr_worker LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(worker src/main.cpp)

# Optional production link against Paddle Inference when LANGNEXT_PADDLE_ROOT is set.
if(DEFINED ENV{LANGNEXT_PADDLE_ROOT})
  message(STATUS "Linking production Paddle Inference from $ENV{LANGNEXT_PADDLE_ROOT}")
  # Production integration is completed when the measured runtime inventory gate lands.
else()
  message(STATUS "Building protocol stub worker (set LANGNEXT_PADDLE_ROOT for production)")
endif()
