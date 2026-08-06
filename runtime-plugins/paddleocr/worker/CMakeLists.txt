# ABOUTME: CMake project for the first-party PaddleOCR native worker executable.
# ABOUTME: Mirrors PaddleOCR deploy/cpp_infer Windows flags and links PP-OCRv6 production stack.
cmake_minimum_required(VERSION 3.29)
project(langnext_paddleocr_worker CXX)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED True)

option(WITH_MKL "Compile with MKL/oneDNN support" ON)
option(WITH_GPU "Compile with GPU" OFF)
option(WITH_STATIC_LIB "Use static CRT flags matching Paddle third_party" ON)

if(DEFINED ENV{LANGNEXT_PADDLE_ROOT} AND NOT DEFINED LANGNEXT_PADDLE_ROOT)
  set(LANGNEXT_PADDLE_ROOT "$ENV{LANGNEXT_PADDLE_ROOT}")
endif()
if(DEFINED ENV{OPENCV_DIR} AND NOT DEFINED OPENCV_DIR)
  set(OPENCV_DIR "$ENV{OPENCV_DIR}")
endif()
if(DEFINED ENV{PADDLEOCR_CPP_INFER} AND NOT DEFINED PADDLEOCR_CPP_INFER)
  set(PADDLEOCR_CPP_INFER "$ENV{PADDLEOCR_CPP_INFER}")
endif()

if(NOT DEFINED LANGNEXT_PADDLE_ROOT)
  message(FATAL_ERROR "Set LANGNEXT_PADDLE_ROOT")
endif()
if(NOT DEFINED OPENCV_DIR)
  message(FATAL_ERROR "Set OPENCV_DIR")
endif()
if(NOT DEFINED PADDLEOCR_CPP_INFER)
  message(FATAL_ERROR "Set PADDLEOCR_CPP_INFER")
endif()

set(PADDLE_LIB "${LANGNEXT_PADDLE_ROOT}")
message(STATUS "PADDLE_LIB=${PADDLE_LIB}")
message(STATUS "OPENCV_DIR=${OPENCV_DIR}")
message(STATUS "PADDLEOCR_CPP_INFER=${PADDLEOCR_CPP_INFER}")

macro(safe_set_static_flag)
  foreach(flag_var
      CMAKE_CXX_FLAGS CMAKE_CXX_FLAGS_DEBUG CMAKE_CXX_FLAGS_RELEASE
      CMAKE_CXX_FLAGS_MINSIZEREL CMAKE_CXX_FLAGS_RELWITHDEBINFO)
    if(${${flag_var}} MATCHES "/MD")
      string(REGEX REPLACE "/MD" "/MT" ${flag_var} "${${flag_var}}")
    endif()
  endforeach(flag_var)
endmacro()

if(WITH_MKL)
  add_definitions(-DUSE_MKL)
endif()

if(WIN32)
  include_directories("${PADDLE_LIB}/paddle/include")
  link_directories("${PADDLE_LIB}/paddle/lib")
  set(CMAKE_CONFIGURATION_TYPES "Debug;Release" CACHE STRING "" FORCE)
  set(OpenCV_DIR "${OPENCV_DIR}/x64/vc16/lib")
  find_package(OpenCV REQUIRED)
else()
  set(OpenCV_DIR "${OPENCV_DIR}/lib64/cmake/opencv4")
  find_package(OpenCV REQUIRED)
  include_directories("${PADDLE_LIB}/paddle/include")
  link_directories("${PADDLE_LIB}/paddle/lib")
endif()
include_directories(${OpenCV_INCLUDE_DIRS})
include_directories("${PADDLEOCR_CPP_INFER}")

if(WIN32)
  add_definitions("/DGOOGLE_GLOG_DLL_DECL=")
  if(WITH_MKL)
    set(FLAG_OPENMP "/openmp")
  endif()
  set(CMAKE_C_FLAGS_DEBUG "${CMAKE_C_FLAGS_DEBUG} /bigobj /MTd ${FLAG_OPENMP}")
  set(CMAKE_C_FLAGS_RELEASE "${CMAKE_C_FLAGS_RELEASE} /bigobj /MT ${FLAG_OPENMP}")
  set(CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG} /bigobj /MTd ${FLAG_OPENMP}")
  set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} /bigobj /MT ${FLAG_OPENMP}")
  if(WITH_STATIC_LIB)
    safe_set_static_flag()
    add_definitions(-DSTATIC_LIB)
    add_definitions(-DYAML_CPP_STATIC_DEFINE)
  endif()
endif()

if(DEFINED ENV{LANGNEXT_DIRENT_INCLUDE})
  include_directories("$ENV{LANGNEXT_DIRENT_INCLUDE}")
elseif(EXISTS "F:/workspace/sdks/include/dirent.h")
  include_directories("F:/workspace/sdks/include")
endif()

include_directories("${PADDLE_LIB}/third_party/install/protobuf/include")
include_directories("${PADDLE_LIB}/third_party/install/glog/include")
include_directories("${PADDLE_LIB}/third_party/install/gflags/include")
include_directories("${PADDLE_LIB}/third_party/install/xxhash/include")
include_directories("${PADDLE_LIB}/third_party/install/yaml-cpp/include")
include_directories("${PADDLE_LIB}/third_party/boost")
include_directories("${PADDLE_LIB}/third_party/eigen3")
include_directories("${PADDLE_LIB}/paddle/include/")

link_directories("${PADDLE_LIB}/third_party/install/protobuf/lib")
link_directories("${PADDLE_LIB}/third_party/install/glog/lib")
link_directories("${PADDLE_LIB}/third_party/install/gflags/lib")
link_directories("${PADDLE_LIB}/third_party/install/xxhash/lib")
link_directories("${PADDLE_LIB}/third_party/install/yaml-cpp/lib")
link_directories("${PADDLE_LIB}/paddle/lib")

if(WITH_MKL)
  include_directories("${PADDLE_LIB}/third_party/install/mklml/include")
  if(WIN32)
    set(MATH_LIB ${PADDLE_LIB}/third_party/install/mklml/lib/mklml.lib
      ${PADDLE_LIB}/third_party/install/mklml/lib/libiomp5md.lib)
  endif()
  set(MKLDNN_PATH "${PADDLE_LIB}/third_party/install/onednn")
  if(EXISTS ${MKLDNN_PATH})
    include_directories("${MKLDNN_PATH}/include")
    if(WIN32)
      set(MKLDNN_LIB ${MKLDNN_PATH}/lib/mkldnn.lib)
    endif()
  endif()
endif()

if(WITH_STATIC_LIB)
  if(WIN32)
    set(DEPS ${PADDLE_LIB}/paddle/lib/paddle_inference${CMAKE_STATIC_LIBRARY_SUFFIX})
  endif()
else()
  if(WIN32)
    set(DEPS ${PADDLE_LIB}/paddle/lib/paddle_inference${CMAKE_SHARED_LIBRARY_SUFFIX})
  endif()
endif()

if(WIN32)
  set(DEPS ${DEPS}
    ${MATH_LIB} ${MKLDNN_LIB}
    glog gflags_static libprotobuf xxhash)
  set(DEPS ${DEPS} libcmt shlwapi)
endif()

if(EXISTS "${PADDLE_LIB}/third_party/install/yaml-cpp/lib")
  set(DEPS ${DEPS} yaml-cpp)
endif()

set(THIRD_PARTY_PATH ${CMAKE_CURRENT_BINARY_DIR}/third_party)
function(download_and_decompress url filename decompress_dir)
  if(NOT EXISTS "${filename}" AND NOT EXISTS "${decompress_dir}")
    message(STATUS "Downloading ${url}")
    file(DOWNLOAD ${url} "${filename}.tmp" SHOW_PROGRESS)
    file(RENAME "${filename}.tmp" ${filename})
  endif()
  if(NOT EXISTS ${decompress_dir})
    file(MAKE_DIRECTORY ${decompress_dir})
    message(STATUS "Decompress ${filename}")
    execute_process(COMMAND ${CMAKE_COMMAND} -E tar -xf ${filename} WORKING_DIRECTORY ${decompress_dir})
  endif()
endfunction()

set(PACKAGE_LIST abseil-cpp clipper_ver6.4.2 nlohmann)
foreach(PKG ${PACKAGE_LIST})
  set(PKG_URL "https://paddle-model-ecology.bj.bcebos.com/paddlex/cpp/libs/${PKG}.tgz")
  set(PKG_TGZ_PATH "${CMAKE_CURRENT_BINARY_DIR}/${PKG}.tgz")
  set(PKG_DST_PATH "${THIRD_PARTY_PATH}/${PKG}")
  download_and_decompress(${PKG_URL} ${PKG_TGZ_PATH} ${PKG_DST_PATH})
endforeach()
set(_CLIPPER_CMAKE "${THIRD_PARTY_PATH}/clipper_ver6.4.2/cpp/CMakeLists.txt")
if(EXISTS "${_CLIPPER_CMAKE}")
  file(READ "${_CLIPPER_CMAKE}" _CLIPPER_CMAKE_CONTENT)
  string(REGEX REPLACE
    "[Cc][Mm][Aa][Kk][Ee]_[Mm][Ii][Nn][Ii][Mm][Uu][Mm]_[Rr][Ee][Qq][Uu][Ii][Rr][Ee][Dd][ \t]*\\([ \t]*VERSION[ \t]*[0-9.]+"
    "CMAKE_MINIMUM_REQUIRED(VERSION 3.10"
    _CLIPPER_CMAKE_CONTENT "${_CLIPPER_CMAKE_CONTENT}")
  file(WRITE "${_CLIPPER_CMAKE}" "${_CLIPPER_CMAKE_CONTENT}")
endif()

add_subdirectory("${THIRD_PARTY_PATH}/abseil-cpp" "${CMAKE_CURRENT_BINARY_DIR}/abseil-cpp")
add_subdirectory("${THIRD_PARTY_PATH}/clipper_ver6.4.2/cpp" "${CMAKE_CURRENT_BINARY_DIR}/clipper")
include_directories(${POLYCLIPPING_INCLUDE_DIR})
include_directories("${THIRD_PARTY_PATH}")
set(DEPS ${DEPS} ${OpenCV_LIBS})
set(DEPS ${DEPS} absl::statusor)
set(DEPS ${DEPS} polyclipping)

file(GLOB_RECURSE SRC_LIST "${PADDLEOCR_CPP_INFER}/src/*.cc")
add_executable(worker src/main.cpp ${SRC_LIST})
target_link_libraries(worker ${DEPS})

if(WIN32 AND WITH_MKL)
  add_custom_command(TARGET worker POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different ${PADDLE_LIB}/third_party/install/mklml/lib/mklml.dll $<TARGET_FILE_DIR:worker>/mklml.dll
    COMMAND ${CMAKE_COMMAND} -E copy_if_different ${PADDLE_LIB}/third_party/install/mklml/lib/libiomp5md.dll $<TARGET_FILE_DIR:worker>/libiomp5md.dll
    COMMAND ${CMAKE_COMMAND} -E copy_if_different ${PADDLE_LIB}/third_party/install/onednn/lib/mkldnn.dll $<TARGET_FILE_DIR:worker>/mkldnn.dll
    COMMAND ${CMAKE_COMMAND} -E copy_if_different ${PADDLE_LIB}/paddle/lib/paddle_inference.dll $<TARGET_FILE_DIR:worker>/paddle_inference.dll
    COMMAND ${CMAKE_COMMAND} -E copy_if_different ${PADDLE_LIB}/paddle/lib/common.dll $<TARGET_FILE_DIR:worker>/common.dll
    COMMAND ${CMAKE_COMMAND} -E copy_if_different ${PADDLE_LIB}/paddle/lib/phi.dll $<TARGET_FILE_DIR:worker>/phi.dll
    COMMAND ${CMAKE_COMMAND} -E copy_if_different ${OPENCV_DIR}/x64/vc16/bin/opencv_world470.dll $<TARGET_FILE_DIR:worker>/opencv_world470.dll
  )
endif()
