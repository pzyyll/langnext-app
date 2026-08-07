# PaddleOCR cpp_infer patches

## text-detection-resize-long

PP-OCRv6 medium det `inference.yml` sets `DetResizeForTest: null`.
Upstream `TextDetPredictor::Build` calls `pre_tfs.at("DetResizeForTest.resize_long")`,
which throws MSVC `invalid unordered_map key`.

Applied under:
`PaddleOCR/deploy/cpp_infer/src/modules/text_detection/predictor.cc`

Behavior: if key missing, use `resize_long = 960` (limit_side_len / limit_type still drive resize).

Re-apply after upgrading the PaddleOCR checkout under `F:/workspace/sdks/paddleocr`.
