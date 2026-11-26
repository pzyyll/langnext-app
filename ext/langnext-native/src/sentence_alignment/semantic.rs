use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use fastembed::{
    InitOptionsUserDefined, Pooling, TextEmbedding, TokenizerFiles, UserDefinedEmbeddingModel,
};
use sha2::{Digest, Sha256};

use super::{SemanticModelAsset, Sentence, SentenceAlignmentPair, collect_block_sentences};

const MODEL_REVISION: &str = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
const MODEL_DIRECTORY: &str = "sentence-alignment-e5-small-int8-v1";
const MAX_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_SENTENCES_PER_SIDE: usize = 64;
const INFERENCE_BATCH_SIZE: usize = 8;
const INFERENCE_THREADS: usize = 2;
const MIN_SIMILARITY: f32 = 0.82;
const MERGE_PENALTY: f32 = 0.035;
const MODEL_ERROR: &str = "The semantic alignment model is unavailable.";
const INSTALL_ERROR: &str = "Could not install the semantic alignment model.";

struct Asset {
    remote: &'static str,
    file: &'static str,
    bytes: u32,
    sha256: &'static str,
}

const ASSETS: &[Asset] = &[
    Asset {
        remote: "config.json",
        file: "config.json",
        bytes: 658,
        sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
    },
    Asset {
        remote: "special_tokens_map.json",
        file: "special_tokens_map.json",
        bytes: 167,
        sha256: "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7",
    },
    Asset {
        remote: "tokenizer_config.json",
        file: "tokenizer_config.json",
        bytes: 443,
        sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
    },
    Asset {
        remote: "tokenizer.json",
        file: "tokenizer.json",
        bytes: 17_082_730,
        sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
    },
    Asset {
        remote: "onnx/model_int8.onnx",
        file: "model_int8.onnx",
        bytes: 118_054_593,
        sha256: "4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c",
    },
];

static RUNTIME: Mutex<Option<(PathBuf, TextEmbedding)>> = Mutex::new(None);

pub(super) fn assets() -> Vec<SemanticModelAsset> {
    ASSETS.iter().enumerate().map(|(id, asset)| SemanticModelAsset {
        id: id as u32,
        bytes: asset.bytes,
        url: format!("https://huggingface.co/Xenova/multilingual-e5-small/resolve/{MODEL_REVISION}/{}?download=true", asset.remote),
    }).collect()
}

pub(super) fn directory(root: &Path) -> PathBuf {
    root.join(MODEL_DIRECTORY)
}

pub(super) fn ready(directory: &Path) -> bool {
    ASSETS.iter().all(|asset| {
        fs::metadata(directory.join(asset.file))
            .is_ok_and(|file| file.is_file() && file.len() == u64::from(asset.bytes))
    })
}

fn partial(directory: &Path, asset: &Asset) -> PathBuf {
    directory.join(format!("{}.part", asset.file))
}

pub(super) fn append(directory: &Path, id: u32, offset: u32, chunk: &[u8]) -> Result<(), String> {
    let asset = ASSETS.get(id as usize).ok_or(INSTALL_ERROR)?;
    if chunk.is_empty()
        || chunk.len() > MAX_CHUNK_BYTES
        || u64::from(offset) + chunk.len() as u64 > u64::from(asset.bytes)
    {
        return Err(INSTALL_ERROR.into());
    }
    fs::create_dir_all(directory).map_err(|_| INSTALL_ERROR)?;
    let path = partial(directory, asset);
    let mut file = OpenOptions::new()
        .create(offset == 0)
        .truncate(offset == 0)
        .append(offset != 0)
        .write(true)
        .open(path)
        .map_err(|_| INSTALL_ERROR)?;
    if file.metadata().map_err(|_| INSTALL_ERROR)?.len() != u64::from(offset) {
        return Err(INSTALL_ERROR.into());
    }
    file.write_all(chunk).map_err(|_| INSTALL_ERROR.into())
}

fn verified(path: &Path, asset: &Asset) -> bool {
    fn digest(path: &Path, length: u32) -> std::io::Result<String> {
        let mut file = File::open(path)?;
        if file.metadata()?.len() != u64::from(length) {
            return Ok(String::new());
        }
        let mut sha = Sha256::new();
        let mut buffer = [0; 64 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            sha.update(&buffer[..count]);
        }
        Ok(format!("{:x}", sha.finalize()))
    }
    digest(path, asset.bytes).is_ok_and(|actual| actual == asset.sha256)
}

pub(super) fn finish(directory: &Path, id: u32) -> Result<(), String> {
    let asset = ASSETS.get(id as usize).ok_or(INSTALL_ERROR)?;
    let path = partial(directory, asset);
    if !verified(&path, asset) {
        return Err(INSTALL_ERROR.into());
    }
    fs::rename(path, directory.join(asset.file)).map_err(|_| INSTALL_ERROR.into())
}

pub(super) fn cleanup(directory: &Path) {
    for asset in ASSETS {
        let _ = fs::remove_file(partial(directory, asset));
    }
}

pub(super) fn installed(directory: &Path) -> bool {
    ASSETS
        .iter()
        .all(|asset| verified(&directory.join(asset.file), asset))
}

fn load(directory: &Path) -> Result<TextEmbedding, String> {
    if !installed(directory) {
        return Err(MODEL_ERROR.into());
    }
    let read = |name| fs::read(directory.join(name)).map_err(|_| MODEL_ERROR);
    let model = UserDefinedEmbeddingModel::new(
        read("model_int8.onnx")?,
        TokenizerFiles {
            tokenizer_file: read("tokenizer.json")?,
            config_file: read("config.json")?,
            special_tokens_map_file: read("special_tokens_map.json")?,
            tokenizer_config_file: read("tokenizer_config.json")?,
        },
    )
    .with_pooling(Pooling::Mean);
    TextEmbedding::try_new_from_user_defined(
        model,
        InitOptionsUserDefined::default().with_intra_threads(INFERENCE_THREADS),
    )
    .map_err(|_| MODEL_ERROR.into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Match {
    source: usize,
    target: usize,
    source_len: usize,
    target_len: usize,
}

fn align_scores(
    source_len: usize,
    target_len: usize,
    score: impl Fn(Match) -> Option<f32>,
) -> Vec<Match> {
    let width = target_len + 1;
    let mut dp = vec![(0.0, (0, 0), None); (source_len + 1) * width];
    for source in (0..=source_len).rev() {
        for target in (0..=target_len).rev() {
            let index = source * width + target;
            if source < source_len {
                dp[index] = (dp[index + width].0, (source + 1, target), None);
            }
            if target < target_len && (source == source_len || dp[index + 1].0 > dp[index].0) {
                dp[index] = (dp[index + 1].0, (source, target + 1), None);
            }
            for (s, t) in [(1, 1), (1, 2), (2, 1)] {
                if source + s > source_len || target + t > target_len {
                    continue;
                }
                let step = Match {
                    source,
                    target,
                    source_len: s,
                    target_len: t,
                };
                let Some(similarity) = score(step) else {
                    continue;
                };
                let gain = similarity - MIN_SIMILARITY - MERGE_PENALTY * (s + t - 2) as f32;
                if gain <= 0.0 {
                    continue;
                }
                let value = gain + dp[(source + s) * width + target + t].0;
                if value > dp[index].0 {
                    dp[index] = (value, (source + s, target + t), Some(step));
                }
            }
        }
    }
    let mut pairs = Vec::new();
    let (mut s, mut t) = (0, 0);
    while s < source_len || t < target_len {
        let (_, next, step) = dp[s * width + t];
        pairs.extend(step);
        (s, t) = next;
    }
    pairs
}

fn add_spans(sentences: &[Sentence<'_>], inputs: &mut Vec<String>) -> Vec<[Option<usize>; 2]> {
    sentences
        .iter()
        .enumerate()
        .map(|(i, sentence)| {
            let single = inputs.len();
            inputs.push(format!("query: {}", sentence.text));
            let double = sentences
                .get(i + 1)
                .filter(|next| next.group_id == sentence.group_id)
                .map(|next| {
                    let index = inputs.len();
                    inputs.push(format!("query: {} {}", sentence.text, next.text));
                    index
                });
            [Some(single), double]
        })
        .collect()
}

pub(super) fn align(
    directory: &Path,
    source: &str,
    blocks: &[Option<String>],
) -> Result<Option<Vec<SentenceAlignmentPair>>, String> {
    let mut sources = Vec::new();
    let mut targets = Vec::new();
    collect_block_sentences(source, 0, &mut sources, &mut Vec::new());
    let mut target_groups = Vec::new();
    for (index, block) in blocks.iter().enumerate() {
        if let Some(text) = block {
            collect_block_sentences(text, index as u32, &mut targets, &mut target_groups);
        }
    }
    if sources.len() > MAX_SENTENCES_PER_SIDE
        || targets.len() > MAX_SENTENCES_PER_SIDE
        || !ready(directory)
    {
        return Ok(None);
    }
    if sources.is_empty() || targets.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let mut inputs = Vec::new();
    let source_spans = add_spans(&sources, &mut inputs);
    let target_spans = add_spans(&targets, &mut inputs);
    let mut runtime = RUNTIME.lock().map_err(|_| MODEL_ERROR)?;
    if runtime.as_ref().is_none_or(|(path, _)| path != directory) {
        *runtime = Some((directory.to_owned(), load(directory)?));
    }
    let (_, model) = runtime.as_mut().ok_or(MODEL_ERROR)?;
    let embeddings = model
        .embed(&inputs, Some(INFERENCE_BATCH_SIZE))
        .map_err(|_| MODEL_ERROR)?;
    drop(runtime);
    let steps = align_scores(sources.len(), targets.len(), |step| {
        let a = source_spans[step.source][step.source_len - 1]?;
        let b = target_spans[step.target][step.target_len - 1]?;
        let score = embeddings
            .get(a)?
            .iter()
            .zip(embeddings.get(b)?)
            .map(|(a, b)| a * b)
            .sum::<f32>();
        score.is_finite().then_some(score)
    });
    Ok(Some(
        steps
            .into_iter()
            .map(|step| {
                let source = sources[step.source];
                let target = targets[step.target];
                SentenceAlignmentPair {
                    source_start: source.utf16_start,
                    source_end: sources[step.source + step.source_len - 1].utf16_end,
                    target_block_index: target.block_index,
                    target_start: target.utf16_start,
                    target_end: targets[step.target + step.target_len - 1].utf16_end,
                }
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires the pinned model in LANGNEXT_ALIGNMENT_MODEL_DIR"]
    fn aligns_reported_prose_and_markdown_with_the_real_model() {
        let directory = PathBuf::from(std::env::var_os("LANGNEXT_ALIGNMENT_MODEL_DIR").unwrap());
        let sources = [
            "The app sends Anki requests only to `http://127.0.0.1:8765`.",
            "On a complete forward result, select **Add to Anki**.",
            "That press sends the card's source text and its translation.",
            "It does not send history, a back-translation, or another card.",
            "If the source already exists in the chosen deck and note type, Anki does not change it.",
        ];
        let anki = [
            "该应用仅向 http://127.0.0.1:8765 发送 Anki 请求。",
            "在完全正向翻译结果中，请选择 添加到 Anki。",
            "点击该选项将发送该卡片的源文本及其翻译内容。",
            "它不会发送历史记录、反向翻译或其他卡片。",
            "如果源文本在所选牌组和笔记类型中已存在，Anki 不会对其进行修改。",
        ];
        assert_matches(
            &directory,
            &sources.join(" "),
            &[Some(anki.join(""))],
            &sources,
            &anki,
        );

        let quick = [
            "## Quick Translate",
            "Quick Translate runs in a compact floating panel (`420 × 360` points, available even when the main window is hidden) and supports independent multi-preset result cards sharing one source input and language pair:",
            "- **Card order**: Drag a preset card's header, or focus its grip and press the up or down arrow key, to reorder the cards.",
            "Select the header away from its chips and buttons to collapse or expand the card.",
            "The order is saved with the popup's preferences.",
        ];
        let target = [
            "快速翻译",
            "“快速翻译”功能运行在一个紧凑的浮动面板中（420 × 360 点，即使主窗口被隐藏时也可使用），并支持独立的多预设结果卡片共享同一源输入和语言对：",
            "卡片顺序：拖动预设卡片的标题栏，或选中其控制柄并按上下箭头键，即可重新排列卡片顺序。",
            "选中标题栏（避开其中的图标和按钮）可折叠或展开该卡片。",
            "排序顺序将随弹出窗口的偏好设置一同保存。",
        ];
        let source = format!("{}\n\n{}\n\n{}", quick[0], quick[1], quick[2..].join(" "));
        let blocks = [
            Some(target[0].into()),
            Some(target[1].into()),
            Some(target[2..].join("")),
        ];
        assert_matches(&directory, &source, &blocks, &quick, &target);

        let unrelated = align(
            &directory,
            "Pick a book from the shelf.",
            &[Some("今天下午可能会下雨。".into())],
        )
        .unwrap()
        .unwrap();
        assert!(unrelated.is_empty());
    }

    fn assert_matches(
        directory: &Path,
        source: &str,
        blocks: &[Option<String>],
        source_expected: &[&str],
        target_expected: &[&str],
    ) {
        let slice = |text: &str, start: u32, end: u32| {
            let units: Vec<_> = text.encode_utf16().collect();
            String::from_utf16(&units[start as usize..end as usize]).unwrap()
        };
        let actual: Vec<_> = align(directory, source, blocks)
            .unwrap()
            .unwrap()
            .into_iter()
            .map(|pair| {
                (
                    slice(source, pair.source_start, pair.source_end),
                    slice(
                        blocks[pair.target_block_index as usize].as_deref().unwrap(),
                        pair.target_start,
                        pair.target_end,
                    ),
                )
            })
            .collect();
        let expected: Vec<_> = source_expected
            .iter()
            .zip(target_expected)
            .map(|(&s, &t)| (s.to_owned(), t.to_owned()))
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn aligns_sentences_in_order_and_skips_unrelated_text() {
        let first = Match {
            source: 0,
            target: 0,
            source_len: 1,
            target_len: 1,
        };
        let split = Match {
            source: 1,
            target: 2,
            source_len: 1,
            target_len: 2,
        };
        let scores = |candidate| {
            if candidate == first || candidate == split {
                Some(0.94)
            } else {
                Some(0.74)
            }
        };
        assert_eq!(align_scores(2, 4, scores), [first, split]);
    }
}
