// ABOUTME: PaddleOCR native worker entrypoint implementing the host framed OCR protocol.
// ABOUTME: Production builds initialize PP-OCRv6 models; default stub echoes fixture text.
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

namespace {

constexpr uint32_t kFrameMagic = 0x4C4E5750u; // LNWP
constexpr uint16_t kKindHandshake = 1;
constexpr uint16_t kKindReady = 2;
constexpr uint16_t kKindOcrRequest = 3;
constexpr uint16_t kKindOcrResponse = 4;
constexpr uint16_t kKindShutdown = 6;

bool read_exact(std::istream& in, void* buf, size_t n) {
  in.read(static_cast<char*>(buf), static_cast<std::streamsize>(n));
  return static_cast<size_t>(in.gcount()) == n;
}

bool write_exact(std::ostream& out, const void* buf, size_t n) {
  out.write(static_cast<const char*>(buf), static_cast<std::streamsize>(n));
  return static_cast<bool>(out);
}

bool write_frame(std::ostream& out, uint16_t kind, const std::string& payload) {
  uint32_t magic = kFrameMagic;
  uint32_t len = static_cast<uint32_t>(payload.size());
  // big-endian helpers
  auto be32 = [](uint32_t v) {
    return std::vector<uint8_t>{
      static_cast<uint8_t>((v >> 24) & 0xff),
      static_cast<uint8_t>((v >> 16) & 0xff),
      static_cast<uint8_t>((v >> 8) & 0xff),
      static_cast<uint8_t>(v & 0xff),
    };
  };
  auto be16 = [](uint16_t v) {
    return std::vector<uint8_t>{
      static_cast<uint8_t>((v >> 8) & 0xff),
      static_cast<uint8_t>(v & 0xff),
    };
  };
  auto m = be32(magic);
  auto k = be16(kind);
  auto l = be32(len);
  return write_exact(out, m.data(), m.size()) && write_exact(out, k.data(), k.size()) &&
         write_exact(out, l.data(), l.size()) &&
         (payload.empty() || write_exact(out, payload.data(), payload.size())) &&
         (out.flush(), true);
}

bool read_frame(std::istream& in, uint16_t* kind, std::string* payload) {
  uint8_t header[10];
  if (!read_exact(in, header, sizeof(header))) {
    return false;
  }
  uint32_t magic = (uint32_t(header[0]) << 24) | (uint32_t(header[1]) << 16) | (uint32_t(header[2]) << 8) |
                   uint32_t(header[3]);
  if (magic != kFrameMagic) {
    return false;
  }
  *kind = (uint16_t(header[4]) << 8) | uint16_t(header[5]);
  uint32_t len = (uint32_t(header[6]) << 24) | (uint32_t(header[7]) << 16) | (uint32_t(header[8]) << 8) |
                 uint32_t(header[9]);
  payload->assign(len, '\0');
  if (len > 0 && !read_exact(in, payload->data(), len)) {
    return false;
  }
  return true;
}

std::string extract_json_string(const std::string& json, const char* key) {
  const std::string needle = std::string("\"") + key + "\":\"";
  auto pos = json.find(needle);
  if (pos == std::string::npos) {
    return {};
  }
  pos += needle.size();
  auto end = json.find('"', pos);
  if (end == std::string::npos) {
    return {};
  }
  return json.substr(pos, end - pos);
}

} // namespace

int main(int argc, char** argv) {
  // Host always supplies --model-root and --process-nonce.
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

  uint16_t kind = 0;
  std::string payload;
  if (!read_frame(std::cin, &kind, &payload) || kind != kKindHandshake) {
    return 3;
  }
  // Echo handshake fields as Ready (production validates model API and digests).
  if (!write_frame(std::cout, kKindReady, payload)) {
    return 4;
  }

  if (!read_frame(std::cin, &kind, &payload) || kind != kKindOcrRequest) {
    return 5;
  }
  const auto request_id = extract_json_string(payload, "requestId");
  // Stub OCR text for protocol conformance; production runs PaddleOCR here.
  const std::string response =
      std::string("{\"requestId\":\"") + request_id + "\",\"text\":\"paddleocr-stub\"}";
  if (!write_frame(std::cout, kKindOcrResponse, response)) {
    return 6;
  }

  // Optional shutdown frame.
  (void)read_frame(std::cin, &kind, &payload);
  return 0;
}
