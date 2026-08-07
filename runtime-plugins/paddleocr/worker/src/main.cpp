// ABOUTME: PaddleOCR native worker entrypoint implementing the host framed OCR protocol.
// ABOUTME: Production builds initialize PP-OCRv6 medium det+rec via official cpp_infer.
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include "src/pipelines/ocr/pipeline.h"
#include "src/pipelines/ocr/result.h"
#include "third_party/nlohmann/json.hpp"

namespace {

constexpr uint32_t kFrameMagic = 0x4C4E5750u; // LNWP
constexpr uint16_t kKindHandshake = 1;
constexpr uint16_t kKindReady = 2;
constexpr uint16_t kKindOcrRequest = 3;
constexpr uint16_t kKindOcrResponse = 4;
constexpr uint16_t kKindShutdown = 6;

#ifdef _WIN32
HANDLE g_protocol_in = INVALID_HANDLE_VALUE;
HANDLE g_protocol_out = INVALID_HANDLE_VALUE;

bool setup_protocol_stdio() {
  // Capture the host pipes before any library can pollute stdout with logs.
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  if (in == INVALID_HANDLE_VALUE || out == INVALID_HANDLE_VALUE) {
    return false;
  }
  if (!DuplicateHandle(GetCurrentProcess(), in, GetCurrentProcess(), &g_protocol_in, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
    return false;
  }
  if (!DuplicateHandle(
        GetCurrentProcess(), out, GetCurrentProcess(), &g_protocol_out, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
    return false;
  }
  // Redirect CRT stdout/stderr so Paddle/cpp_infer logs never enter the protocol stream.
  // Local log file only; protocol I/O uses the duplicated HANDLE pipes above.
  FILE* sink = nullptr;
  freopen_s(&sink, "worker-runtime.log", "w", stdout);
  freopen_s(&sink, "worker-runtime.log", "a", stderr);
  std::ios::sync_with_stdio(true);
  _putenv("GLOG_logtostderr=1");
  _putenv("GLOG_minloglevel=2");
  return true;
}

bool read_exact_handle(HANDLE h, void* buf, size_t n) {
  auto* p = static_cast<char*>(buf);
  size_t got = 0;
  while (got < n) {
    DWORD chunk = 0;
    if (!ReadFile(h, p + got, static_cast<DWORD>(n - got), &chunk, nullptr) || chunk == 0) {
      return false;
    }
    got += chunk;
  }
  return true;
}

bool write_exact_handle(HANDLE h, const void* buf, size_t n) {
  auto* p = static_cast<const char*>(buf);
  size_t sent = 0;
  while (sent < n) {
    DWORD chunk = 0;
    if (!WriteFile(h, p + sent, static_cast<DWORD>(n - sent), &chunk, nullptr) || chunk == 0) {
      return false;
    }
    sent += chunk;
  }
  return true;
}
#else
bool setup_protocol_stdio() {
  return true;
}
bool read_exact_handle(int, void* buf, size_t n) {
  auto* p = static_cast<char*>(buf);
  size_t got = 0;
  while (got < n) {
    std::streamsize r = std::cin.readsome(p + got, static_cast<std::streamsize>(n - got));
    if (r <= 0) {
      std::cin.read(p + got, static_cast<std::streamsize>(n - got));
      r = std::cin.gcount();
      if (r <= 0) {
        return false;
      }
    }
    got += static_cast<size_t>(r);
  }
  return true;
}
bool write_exact_handle(int, const void* buf, size_t n) {
  std::cout.write(static_cast<const char*>(buf), static_cast<std::streamsize>(n));
  std::cout.flush();
  return static_cast<bool>(std::cout);
}
#endif

bool write_frame(uint16_t kind, const std::string& payload) {
  uint8_t header[10] = {
    static_cast<uint8_t>((kFrameMagic >> 24) & 0xff),
    static_cast<uint8_t>((kFrameMagic >> 16) & 0xff),
    static_cast<uint8_t>((kFrameMagic >> 8) & 0xff),
    static_cast<uint8_t>(kFrameMagic & 0xff),
    static_cast<uint8_t>((kind >> 8) & 0xff),
    static_cast<uint8_t>(kind & 0xff),
    static_cast<uint8_t>((payload.size() >> 24) & 0xff),
    static_cast<uint8_t>((payload.size() >> 16) & 0xff),
    static_cast<uint8_t>((payload.size() >> 8) & 0xff),
    static_cast<uint8_t>(payload.size() & 0xff),
  };
#ifdef _WIN32
  return write_exact_handle(g_protocol_out, header, sizeof(header)) &&
         (payload.empty() || write_exact_handle(g_protocol_out, payload.data(), payload.size()));
#else
  return write_exact_handle(0, header, sizeof(header)) &&
         (payload.empty() || write_exact_handle(0, payload.data(), payload.size()));
#endif
}

bool read_frame(uint16_t* kind, std::string* payload) {
  uint8_t header[10];
#ifdef _WIN32
  if (!read_exact_handle(g_protocol_in, header, sizeof(header))) {
    return false;
  }
#else
  if (!read_exact_handle(0, header, sizeof(header))) {
    return false;
  }
#endif
  uint32_t magic = (uint32_t(header[0]) << 24) | (uint32_t(header[1]) << 16) | (uint32_t(header[2]) << 8) |
                   uint32_t(header[3]);
  if (magic != kFrameMagic) {
    return false;
  }
  *kind = (uint16_t(header[4]) << 8) | uint16_t(header[5]);
  uint32_t len = (uint32_t(header[6]) << 24) | (uint32_t(header[7]) << 16) | (uint32_t(header[8]) << 8) |
                 uint32_t(header[9]);
  payload->assign(len, '\0');
  if (len == 0) {
    return true;
  }
#ifdef _WIN32
  return read_exact_handle(g_protocol_in, &(*payload)[0], len);
#else
  return read_exact_handle(0, &(*payload)[0], len);
#endif
}

std::string join_rec_texts(const OCRPipelineResult& result) {
  std::ostringstream out;
  for (size_t i = 0; i < result.rec_texts.size(); ++i) {
    if (i > 0) {
      out << '\n';
    }
    out << result.rec_texts[i];
  }
  return out.str();
}

std::string json_escape(const std::string& input) {
  std::string out;
  out.reserve(input.size() + 8);
  for (unsigned char c : input) {
    switch (c) {
      case '\\':
        out += "\\\\";
        break;
      case '"':
        out += "\\\"";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  return out;
}

bool write_temp_png(const std::vector<uint8_t>& png_bytes, std::string* path_out) {
#ifdef _WIN32
  char temp_dir[MAX_PATH];
  char temp_file[MAX_PATH];
  if (GetTempPathA(MAX_PATH, temp_dir) == 0) {
    return false;
  }
  if (GetTempFileNameA(temp_dir, "lnocr", 0, temp_file) == 0) {
    return false;
  }
  std::string path = temp_file;
  if (path.size() > 4) {
    path.replace(path.size() - 4, 4, ".png");
    DeleteFileA(temp_file);
  }
#else
  std::string path = "/tmp/langnext-ocr.png";
#endif
  std::ofstream out(path, std::ios::binary);
  if (!out) {
    return false;
  }
  out.write(reinterpret_cast<const char*>(png_bytes.data()), static_cast<std::streamsize>(png_bytes.size()));
  if (!out) {
    return false;
  }
  *path_out = path;
  return true;
}

void delete_temp_file(const std::string& path) {
#ifdef _WIN32
  DeleteFileA(path.c_str());
#else
  std::remove(path.c_str());
#endif
}

std::string normalize_path(std::string path) {
  for (char& c : path) {
    if (c == '\\') {
      c = '/';
    }
  }
  return path;
}

OCRPipelineParams make_params(const std::string& model_root) {
  OCRPipelineParams params;
  // PP-OCRv6 PIR models hit UnimplementedError under onednn/mkldnn path
  // (ConvertPirAttribute2RuntimeAttribute ArrayAttribute<DoubleAttribute>).
  params.enable_mkldnn = false;
  params.cpu_threads = 4;
  params.thread_num = 1;
  params.device = std::string("cpu");

  // Use flattened key map constructor to avoid YAML LoadFile + OverrideConfig rewrite bugs.
  const std::string root = normalize_path(model_root);
  const std::string det = root + "/PP-OCRv6_medium_det_infer";
  const std::string rec = root + "/PP-OCRv6_medium_rec_infer";
  std::unordered_map<std::string, std::string> cfg{
      {"pipeline_name", "OCR"},
      {"text_type", "general"},
      {"use_doc_preprocessor", "false"},
      {"use_doc_orientation_classify", "false"},
      {"use_doc_unwarping", "false"},
      {"use_textline_orientation", "false"},
      {"SubModules.TextDetection.module_name", "text_detection"},
      {"SubModules.TextDetection.model_name", "PP-OCRv6_medium_det"},
      {"SubModules.TextDetection.model_dir", det},
      {"SubModules.TextDetection.limit_side_len", "64"},
      {"SubModules.TextDetection.limit_type", "min"},
      {"SubModules.TextDetection.max_side_limit", "4000"},
      {"SubModules.TextDetection.thresh", "0.3"},
      {"SubModules.TextDetection.box_thresh", "0.6"},
      {"SubModules.TextDetection.unclip_ratio", "1.5"},
      {"SubModules.TextRecognition.module_name", "text_recognition"},
      {"SubModules.TextRecognition.model_name", "PP-OCRv6_medium_rec"},
      {"SubModules.TextRecognition.model_dir", rec},
      {"SubModules.TextRecognition.batch_size", "6"},
      {"SubModules.TextRecognition.score_thresh", "0.0"},
  };
  params.paddlex_config = Utility::PaddleXConfigVariant(cfg);
  return params;
}

} // namespace

int main(int argc, char** argv) {
  if (!setup_protocol_stdio()) {
    return 1;
  }

  std::string model_root;
  std::string process_nonce;
  for (int i = 1; i + 1 < argc; ++i) {
    if (std::strcmp(argv[i], "--model-root") == 0) {
      model_root = argv[++i];
    } else if (std::strcmp(argv[i], "--process-nonce") == 0) {
      process_nonce = argv[++i];
    }
  }
  if (model_root.empty() || process_nonce.empty()) {
    return 2;
  }

  std::unique_ptr<_OCRPipeline> pipeline;
  try {
    pipeline = std::unique_ptr<_OCRPipeline>(new _OCRPipeline(make_params(model_root)));
  } catch (const std::exception& ex) {
    // Write diagnostics outside protocol stdout/stderr (both redirected to NUL).
    std::ofstream diag("worker-init-error.txt", std::ios::out | std::ios::trunc);
    if (diag) {
      diag << "pipeline_init_failed: " << ex.what() << "\nmodel_root=" << model_root << "\n";
    }
    return 10;
  } catch (...) {
    std::ofstream diag("worker-init-error.txt", std::ios::out | std::ios::trunc);
    if (diag) {
      diag << "pipeline_init_failed: unknown\nmodel_root=" << model_root << "\n";
    }
    return 10;
  }

  uint16_t kind = 0;
  std::string payload;
  if (!read_frame(&kind, &payload) || kind != kKindHandshake) {
    return 3;
  }
  if (!write_frame(kKindReady, payload)) {
    return 4;
  }

  while (read_frame(&kind, &payload)) {
    if (kind == kKindShutdown) {
      return 0;
    }
    if (kind != kKindOcrRequest) {
      return 5;
    }

    std::string request_id;
    std::vector<uint8_t> png_bytes;
    try {
      auto json = nlohmann::json::parse(payload);
      request_id = json.at("requestId").get<std::string>();
      png_bytes = json.at("pngBytes").get<std::vector<uint8_t>>();
    } catch (...) {
      return 7;
    }

    std::string temp_png;
    if (!write_temp_png(png_bytes, &temp_png)) {
      return 8;
    }

    std::string text;
    try {
      auto results = pipeline->Predict({temp_png});
      (void)results;
      auto pipeline_results = pipeline->PipelineResult();
      if (!pipeline_results.empty()) {
        text = join_rec_texts(pipeline_results[0]);
      }
    } catch (...) {
      delete_temp_file(temp_png);
      return 9;
    }
    delete_temp_file(temp_png);

    const std::string response =
        std::string("{\"requestId\":\"") + json_escape(request_id) + "\",\"text\":\"" + json_escape(text) + "\"}";
    if (!write_frame(kKindOcrResponse, response)) {
      return 6;
    }
  }
  return 0;
}
