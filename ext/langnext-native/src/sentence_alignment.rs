//! Conservative local sentence alignment for Quick Translate results.

use std::collections::HashMap;

use nsh_core::prelude::*;
use unicode_segmentation::UnicodeSegmentation;

/// Matched UTF-16 ranges between the source text and one visible target prose block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, JsObject)]
pub struct SentenceAlignmentPair {
    /// Inclusive UTF-16 offset where the source sentence begins.
    pub source_start: u32,
    /// Exclusive UTF-16 offset where the source sentence ends.
    pub source_end: u32,
    /// Zero-based index into the caller's `target_blocks` array.
    pub target_block_index: u32,
    /// Inclusive UTF-16 offset where the target sentence begins inside `target_blocks[target_block_index]`.
    pub target_start: u32,
    /// Exclusive UTF-16 offset where the target sentence ends inside `target_blocks[target_block_index]`.
    pub target_end: u32,
}

/// Local sentence boundary splitting and conservative alignment.
#[module]
pub struct SentenceAlignmentNative;

#[module]
impl SentenceAlignmentNative {
    /// Aligns matching sentences between `source_text` and visible target prose `target_blocks`.
    pub fn align(
        source_text: String,
        target_blocks: Vec<Option<String>>,
    ) -> Vec<SentenceAlignmentPair> {
        align_blocks(&source_text, &target_blocks)
    }
}

#[derive(Debug, Clone, Copy)]
struct Sentence<'a> {
    block_index: u32,
    group_id: usize,
    utf16_start: u32,
    utf16_end: u32,
    text: &'a str,
}

#[derive(Debug, Clone, Copy)]
struct GroupSpan {
    start_sentence: usize,
    end_sentence: usize,
}

fn build_utf16_offsets(text: &str) -> Vec<u32> {
    let mut offsets = vec![0u32; text.len() + 1];
    let mut utf16 = 0u32;
    for (byte_idx, ch) in text.char_indices() {
        offsets[byte_idx] = utf16;
        utf16 += ch.len_utf16() as u32;
    }
    offsets[text.len()] = utf16;
    offsets
}

fn prose_group_byte_ranges(text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut groups = Vec::new();
    let mut active: Option<(usize, usize)> = None;
    let mut i = 0usize;

    while i < bytes.len() {
        let line_start = i;
        while i < bytes.len() && bytes[i] != b'\n' && bytes[i] != b'\r' {
            i += 1;
        }
        let line_end = i;
        if i < bytes.len() {
            if bytes[i] == b'\r' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                i += 2;
            } else {
                i += 1;
            }
        }
        if text[line_start..line_end].trim().is_empty() {
            if let Some(group) = active.take() {
                groups.push(group);
            }
        } else {
            active = Some(match active {
                Some((start, _)) => (start, line_end),
                None => (line_start, line_end),
            });
        }
    }

    if let Some(group) = active {
        groups.push(group);
    }
    groups
}

fn is_sentence_candidate(trimmed: &str) -> bool {
    trimmed.chars().any(char::is_alphanumeric)
}

fn sentence_segments(text: &str) -> impl Iterator<Item = (usize, &str)> {
    let mut boundaries = text.split_sentence_bound_indices().peekable();
    let mut next_opening_quote = None;
    let mut straight_quote_open = false;
    std::iter::from_fn(move || {
        let (offset, segment) = boundaries.next()?;
        let segment = segment.trim_end();
        let start = next_opening_quote.take().unwrap_or(offset);
        let mut end = offset + segment.len();
        straight_quote_open ^= !segment
            .bytes()
            .filter(|&ch| ch == b'"')
            .count()
            .is_multiple_of(2);

        // Unicode sentence boundaries can keep the next sentence's opening quote with the terminator.
        if let Some((_, next)) = boundaries.peek() {
            let opening_quote = match segment.chars().next_back() {
                Some('“') if next.contains('”') => Some('“'),
                Some('"') if straight_quote_open && next.contains('"') => Some('"'),
                _ => None,
            };
            if let Some(quote) = opening_quote {
                end -= quote.len_utf8();
                next_opening_quote = Some(end);
            }
        }
        Some((start, &text[start..end]))
    })
}

fn collect_block_sentences<'a>(
    text: &'a str,
    block_index: u32,
    sentences: &mut Vec<Sentence<'a>>,
    groups: &mut Vec<GroupSpan>,
) {
    let utf16_map = build_utf16_offsets(text);
    for (group_start, group_end) in prose_group_byte_ranges(text) {
        let group_id = groups.len();
        let start_sentence = sentences.len();
        let slice = &text[group_start..group_end];
        for (rel_start, segment) in sentence_segments(slice) {
            let start_trimmed = segment.trim_start();
            let trimmed = start_trimmed.trim_end();
            if !is_sentence_candidate(trimmed) {
                continue;
            }
            let abs_start = group_start + rel_start + segment.len() - start_trimmed.len();
            let abs_end = abs_start + trimmed.len();
            sentences.push(Sentence {
                block_index,
                group_id,
                utf16_start: utf16_map[abs_start],
                utf16_end: utf16_map[abs_end],
                text: trimmed,
            });
        }
        let end_sentence = sentences.len();
        if end_sentence > start_sentence {
            groups.push(GroupSpan {
                start_sentence,
                end_sentence,
            });
        }
    }
}

fn is_literal_anchor_token(token: &str) -> bool {
    let bytes = token.as_bytes();
    bytes.iter().any(u8::is_ascii_digit)
        || (bytes.len() >= 2 && bytes.iter().all(u8::is_ascii_uppercase))
}

fn is_name_anchor_token(token: &str) -> bool {
    const MIN_NAME_ANCHOR_LEN: usize = 4;
    let bytes = token.as_bytes();
    bytes.len() >= MIN_NAME_ANCHOR_LEN
        && bytes[0].is_ascii_uppercase()
        && bytes[1..].iter().all(u8::is_ascii_lowercase)
}

fn for_each_anchor_token<'a>(
    text: &'a str,
    is_candidate: impl Fn(&str) -> bool,
    mut visit: impl FnMut(&'a str),
) {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let token = &text[start..i];
            if is_candidate(token) {
                visit(token);
            }
        } else {
            i += 1;
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
enum UniqueSentence {
    #[default]
    None,
    One(usize),
    Multiple,
}

impl UniqueSentence {
    fn record(&mut self, sentence_idx: usize) {
        *self = match *self {
            Self::None => Self::One(sentence_idx),
            Self::One(prev) if prev == sentence_idx => Self::One(prev),
            Self::One(_) | Self::Multiple => Self::Multiple,
        };
    }

    fn index(self) -> Option<usize> {
        match self {
            Self::One(idx) => Some(idx),
            Self::None | Self::Multiple => None,
        }
    }
}

fn filter_non_conflicting_monotonic(candidates: &mut Vec<(usize, usize)>) {
    candidates.sort_unstable();
    candidates.dedup();
    let snapshot = candidates.clone();
    candidates.retain(|&(s_a, t_a)| {
        !snapshot.iter().any(|&(s_b, t_b)| {
            if s_a == s_b && t_a == t_b {
                return false;
            }
            s_a == s_b || t_a == t_b || (s_a < s_b && t_a > t_b) || (s_a > s_b && t_a < t_b)
        })
    });
}

fn collect_token_anchors(
    source_sentences: &[Sentence<'_>],
    target_sentences: &[Sentence<'_>],
    is_candidate: impl Fn(&str) -> bool,
) -> Vec<(usize, usize)> {
    let mut occurrences: HashMap<&str, (UniqueSentence, UniqueSentence)> = HashMap::new();
    for (idx, sentence) in source_sentences.iter().enumerate() {
        for_each_anchor_token(sentence.text, &is_candidate, |token| {
            occurrences.entry(token).or_default().0.record(idx);
        });
    }
    for (idx, sentence) in target_sentences.iter().enumerate() {
        for_each_anchor_token(sentence.text, &is_candidate, |token| {
            occurrences.entry(token).or_default().1.record(idx);
        });
    }

    occurrences
        .into_values()
        .filter_map(|(src, tgt)| Some((src.index()?, tgt.index()?)))
        .collect()
}

fn count_paired_double_quotes(text: &str) -> usize {
    let mut straight_quotes = 0usize;
    let mut curly_open = 0usize;
    let mut curly_pairs = 0usize;

    for ch in text.chars() {
        match ch {
            '"' => straight_quotes += 1,
            '\u{201C}' => curly_open += 1,
            '\u{201D}' => {
                if curly_open == 0 {
                    return 0;
                }
                curly_open -= 1;
                curly_pairs += 1;
            }
            _ => {}
        }
    }

    if curly_open != 0 || !straight_quotes.is_multiple_of(2) {
        return 0;
    }
    (straight_quotes / 2) + curly_pairs
}

fn collect_quote_anchors(
    source_sentences: &[Sentence<'_>],
    target_sentences: &[Sentence<'_>],
    accepted_literals: &[(usize, usize)],
) -> Vec<(usize, usize)> {
    if accepted_literals.is_empty() {
        return Vec::new();
    }

    let mut by_count: HashMap<usize, (UniqueSentence, UniqueSentence)> = HashMap::new();
    for (idx, sentence) in source_sentences.iter().enumerate() {
        let count = count_paired_double_quotes(sentence.text);
        if count >= 2 {
            by_count.entry(count).or_default().0.record(idx);
        }
    }
    for (idx, sentence) in target_sentences.iter().enumerate() {
        let count = count_paired_double_quotes(sentence.text);
        if count >= 2 {
            by_count.entry(count).or_default().1.record(idx);
        }
    }

    let mut candidates: Vec<(usize, usize)> = by_count
        .into_values()
        .filter_map(|(src, tgt)| Some((src.index()?, tgt.index()?)))
        .filter(|&(sq, tq)| {
            let has_other_literal = accepted_literals
                .iter()
                .any(|&(sl, tl)| (sl, tl) != (sq, tq));
            let order_ok = accepted_literals.iter().all(|&(sl, tl)| {
                (sq == sl && tq == tl) || (sq < sl && tq < tl) || (sq > sl && tq > tl)
            });
            has_other_literal && order_ok
        })
        .collect();
    filter_non_conflicting_monotonic(&mut candidates);
    candidates
}

fn has_excluded_block_between(
    target_blocks: &[Option<String>],
    before: Sentence<'_>,
    after: Sentence<'_>,
) -> bool {
    target_blocks[before.block_index as usize..=after.block_index as usize]
        .iter()
        .any(Option::is_none)
}

fn collect_bounded_name_anchors(
    source_sentences: &[Sentence<'_>],
    target_sentences: &[Sentence<'_>],
    target_blocks: &[Option<String>],
    accepted: &[(usize, usize)],
) -> Vec<(usize, usize)> {
    if accepted.len() < 2 {
        return Vec::new();
    }

    collect_token_anchors(source_sentences, target_sentences, is_name_anchor_token)
        .into_iter()
        .filter(|&(source, target)| {
            let next = accepted.partition_point(|&(index, _)| index < source);
            if next == 0 || next == accepted.len() {
                return false;
            }
            let (left_source, left_target) = accepted[next - 1];
            let (right_source, right_target) = accepted[next];
            source < right_source
                && left_target < target
                && target < right_target
                && source - left_source == target - left_target
                && right_source - source == right_target - target
                && !has_excluded_block_between(
                    target_blocks,
                    target_sentences[left_target],
                    target_sentences[right_target],
                )
        })
        .collect()
}

fn fill_single_sentence_gaps(
    accepted: &[(usize, usize)],
    source_sentences: &[Sentence<'_>],
    source_groups: &[GroupSpan],
    target_sentences: &[Sentence<'_>],
    target_groups: &[GroupSpan],
    target_blocks: &[Option<String>],
) -> Vec<(usize, usize)> {
    let mut pairs = accepted.to_vec();

    for (idx, &(s_idx, t_idx)) in accepted.iter().enumerate() {
        let sg = source_sentences[s_idx].group_id;
        let tg = target_sentences[t_idx].group_id;
        let is_first_in_pair = idx == 0
            || (source_sentences[accepted[idx - 1].0].group_id != sg
                && target_sentences[accepted[idx - 1].1].group_id != tg);
        if is_first_in_pair {
            let s_start = source_groups[sg].start_sentence;
            let t_start = target_groups[tg].start_sentence;
            if s_idx - s_start == 1 && t_idx - t_start == 1 {
                pairs.push((s_start, t_start));
            }
        }

        let is_last_in_pair = idx + 1 == accepted.len()
            || (source_sentences[accepted[idx + 1].0].group_id != sg
                && target_sentences[accepted[idx + 1].1].group_id != tg);
        if is_last_in_pair {
            let s_end = source_groups[sg].end_sentence;
            let t_end = target_groups[tg].end_sentence;
            if s_end - (s_idx + 1) == 1 && t_end - (t_idx + 1) == 1 {
                pairs.push((s_idx + 1, t_idx + 1));
            }
        }
    }

    for window in accepted.windows(2) {
        let (s_a, t_a) = window[0];
        let (s_b, t_b) = window[1];
        if s_b - s_a == 2
            && t_b - t_a == 2
            && !has_excluded_block_between(
                target_blocks,
                target_sentences[t_a],
                target_sentences[t_b],
            )
        {
            pairs.push((s_a + 1, t_a + 1));
        }
    }

    pairs.sort_unstable();
    pairs.dedup();
    pairs
}

pub fn align_blocks(
    source_text: &str,
    target_blocks: &[Option<String>],
) -> Vec<SentenceAlignmentPair> {
    let mut source_sentences = Vec::new();
    let mut source_groups = Vec::new();
    collect_block_sentences(source_text, 0, &mut source_sentences, &mut source_groups);

    let mut target_sentences = Vec::new();
    let mut target_groups = Vec::new();
    let mut has_excluded_block = false;
    for (index, block) in target_blocks.iter().enumerate() {
        match block.as_deref() {
            Some(text) => collect_block_sentences(
                text,
                index as u32,
                &mut target_sentences,
                &mut target_groups,
            ),
            None => has_excluded_block = true,
        }
    }

    if !has_excluded_block && source_sentences.len() == 1 && target_sentences.len() == 1 {
        let s = source_sentences[0];
        let t = target_sentences[0];
        return vec![SentenceAlignmentPair {
            source_start: s.utf16_start,
            source_end: s.utf16_end,
            target_block_index: t.block_index,
            target_start: t.utf16_start,
            target_end: t.utf16_end,
        }];
    }

    let mut accepted = collect_token_anchors(
        &source_sentences,
        &target_sentences,
        is_literal_anchor_token,
    );
    filter_non_conflicting_monotonic(&mut accepted);
    let quote_anchors = collect_quote_anchors(&source_sentences, &target_sentences, &accepted);
    accepted.extend(quote_anchors);
    accepted.sort_unstable();
    accepted.dedup();

    let name_anchors = collect_bounded_name_anchors(
        &source_sentences,
        &target_sentences,
        target_blocks,
        &accepted,
    );
    accepted.extend(name_anchors);
    accepted.sort_unstable();
    accepted.dedup();

    let paired = fill_single_sentence_gaps(
        &accepted,
        &source_sentences,
        &source_groups,
        &target_sentences,
        &target_groups,
        target_blocks,
    );

    paired
        .into_iter()
        .map(|(s_idx, t_idx)| {
            let s = source_sentences[s_idx];
            let t = target_sentences[t_idx];
            SentenceAlignmentPair {
                source_start: s.utf16_start,
                source_end: s.utf16_end,
                target_block_index: t.block_index,
                target_start: t.utf16_start,
                target_end: t.utf16_end,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slice_utf16(text: &str, start: u32, end: u32) -> String {
        let units: Vec<u16> = text.encode_utf16().collect();
        String::from_utf16(&units[start as usize..end as usize])
            .expect("aligned UTF-16 offsets should sit on valid character boundaries")
    }

    fn aligned_texts(source: &str, targets: &[Option<String>]) -> Vec<(String, String)> {
        align_blocks(source, targets)
            .into_iter()
            .map(|pair| {
                (
                    slice_utf16(source, pair.source_start, pair.source_end),
                    slice_utf16(
                        targets[pair.target_block_index as usize]
                            .as_deref()
                            .unwrap(),
                        pair.target_start,
                        pair.target_end,
                    ),
                )
            })
            .collect()
    }

    #[test]
    fn aligns_sentences_starting_with_double_quotes_after_a_period() {
        let source = "NSH is running.\n\nThe interface is ready. Choose \"Light\" or \"Dark\".";
        for (intro, options) in [
            ("界面已就绪。", "“浅色”或“深色”均可选择。"),
            ("界面已就绪。", "\"浅色\"或\"深色\"均可选择。"),
            ("界面提示“已就绪。”", "“浅色”或“深色”均可选择。"),
            ("界面提示\"已就绪。\"", "\"浅色\"或\"深色\"均可选择。"),
        ] {
            let target = format!("NSH 已启动。\n\n{intro}{options}");
            assert_eq!(
                aligned_texts(source, &[Some(target)]),
                [
                    ("NSH is running.".into(), "NSH 已启动。".into()),
                    ("The interface is ready.".into(), intro.into()),
                    ("Choose \"Light\" or \"Dark\".".into(), options.into()),
                ],
                "opening quotes belong to the next sentence: {intro}{options}",
            );
        }
    }

    #[test]
    fn aligns_translations_even_when_the_provider_changes_paragraphs() {
        let source_sentences = [
            "This is an AI-powered translation tool for desktop, built on the NSH Mixed framework, with its interface and state managed via TSX.",
            "For features requiring native code implementation, Rust serves as an extension point.",
            "The initial interface includes a slim sidebar, a custom title bar, and appearance settings.",
            "Options such as \"Light,\" \"Dark,\" and \"Follow system settings\" are persisted even after the application is restarted.",
        ];
        let [first, second, third, fourth] = source_sentences;
        let source = format!("{first}\n{second}\n\n{third} {fourth}");

        let cases = [
            (
                "Google Cloud",
                ["\n\n", "\n\n"],
                [
                    "这是一个基于 NSH Mixed 框架构建的桌面 AI 翻译工具，其界面和状态由 TSX 管理。",
                    "对于需要原生代码实现的功能，Rust 可作为扩展点。",
                    "初始界面包含一个简洁的侧边栏、一个自定义标题栏和外观设置。",
                    "“浅色”、“深色”和“跟随系统设置”等选项即使在应用程序重启后也会保留。",
                ],
            ),
            (
                "DeepL",
                ["\n", "\n\n"],
                [
                    "这是一个基于NSH Mixed框架开发的、面向桌面的AI驱动翻译工具，其界面和状态通过TSX进行管理。",
                    "对于需要原生代码实现的功能，Rust 作为扩展点。",
                    "初始界面包含一个简洁的侧边栏、自定义标题栏以及外观设置。",
                    "诸如“浅色”、“深色”和“遵循系统设置”等选项，即使在应用程序重启后也会被保留。",
                ],
            ),
            (
                "LLM",
                ["\n", "\n"],
                [
                    "这是一个基于NSH Mixed框架构建的桌面AI翻译工具，其界面和状态通过TSX管理。",
                    "对于需要原生代码实现的功能，Rust作为扩展点。",
                    "初始界面包括一个窄侧边栏、一个自定义标题栏和外观设置。",
                    "“浅色”、“深色”和“跟随系统设置”等选项即使在应用程序重启后也会保留。",
                ],
            ),
        ];

        for (engine, [after_first, after_second], target_sentences) in cases {
            let [first, second, third, fourth] = target_sentences;
            let plain = format!("{first}{after_first}{second}{after_second}{third}{fourth}");
            let markdown_blocks: Vec<_> = plain
                .split("\n\n")
                .map(|block| Some(block.replace('\n', " ")))
                .collect();
            let expected: Vec<_> = source_sentences
                .into_iter()
                .zip(target_sentences)
                .map(|(src, tgt)| (src.to_owned(), tgt.to_owned()))
                .collect();
            assert_eq!(
                aligned_texts(&source, &[Some(plain)]),
                expected,
                "{engine} plain text"
            );
            assert_eq!(
                aligned_texts(&source, &markdown_blocks),
                expected,
                "{engine} Markdown blocks"
            );
        }
    }

    #[test]
    fn leaves_bounded_gaps_unpaired_when_clues_are_ambiguous_or_cross_excluded_blocks() {
        let source = "NSH starts. Rust runs first. Rust runs next. TSX finishes.";
        let target = "NSH 起步。Rust 首先运行。Rust 随后运行。TSX 结束。";
        assert_eq!(
            aligned_texts(source, &[Some(target.into())]),
            [
                ("NSH starts.".into(), "NSH 起步。".into()),
                ("TSX finishes.".into(), "TSX 结束。".into()),
            ]
        );

        let source = "NSH starts. Rust runs here. TSX finishes.";
        let target = [
            Some("NSH 起步。Rust 在此运行。".into()),
            None,
            Some("TSX 结束。".into()),
        ];
        assert_eq!(
            aligned_texts(source, &target),
            [
                ("NSH starts.".into(), "NSH 起步。".into()),
                ("TSX finishes.".into(), "TSX 结束。".into()),
            ]
        );
    }

    #[test]
    fn aligns_single_english_and_chinese_sentences_with_leading_spaces_and_emoji() {
        let source = "   😀 Hello world!   ";
        let target = "  😀 你好世界！ ";
        let pairs = align_blocks(source, &[Some(target.to_owned())]);

        assert_eq!(pairs.len(), 1);
        let pair = pairs[0];
        assert_eq!(
            slice_utf16(source, pair.source_start, pair.source_end),
            "😀 Hello world!"
        );
        assert_eq!(pair.target_block_index, 0);
        assert_eq!(
            slice_utf16(target, pair.target_start, pair.target_end),
            "😀 你好世界！"
        );
    }

    #[test]
    fn rejects_blank_punctuation_only_and_excluded_single_sentence_cases() {
        assert!(align_blocks("", &[Some(String::new())]).is_empty());
        assert!(align_blocks("   \r\n  \t ", &[Some("\n\n  ".to_owned())]).is_empty());
        assert!(align_blocks(".", &[Some("。".to_owned())]).is_empty());
        assert!(align_blocks("!", &[Some("！".to_owned())]).is_empty());
        assert!(align_blocks("\"!\"", &[Some("“。”".to_owned())]).is_empty());
        assert!(align_blocks("「？」", &[Some("\"?\"".to_owned())]).is_empty());
        assert!(align_blocks("One sentence.", &[Some("唯一一句。".to_owned()), None]).is_empty());
    }

    #[test]
    fn handles_crlf_blank_lines_and_repeated_sentences() {
        let source_single = "\r\n  😀 First.\r\n\r\n";
        let target_single = "\r\n 😀 第一句。\r\n\r\n";
        let pairs = align_blocks(source_single, &[Some(target_single.to_owned())]);
        assert_eq!(pairs.len(), 1);
        assert_eq!(
            slice_utf16(source_single, pairs[0].source_start, pairs[0].source_end),
            "😀 First."
        );
        assert_eq!(
            slice_utf16(target_single, pairs[0].target_start, pairs[0].target_end),
            "😀 第一句。"
        );

        assert!(
            align_blocks(
                "Repeat me.\r\n\r\nRepeat me.",
                &[Some("重复一次。\r\n\r\n重复一次。".to_owned())],
            )
            .is_empty()
        );
        assert!(
            align_blocks(
                "Same twice. Same twice.",
                &[Some("重复两次。重复两次。".to_owned())],
            )
            .is_empty()
        );
    }

    #[test]
    fn aligns_unique_literal_and_quote_anchors_when_non_conflicting() {
        let source = "Windows supports V2 right now. Langnext uses NSH and TSX safely. Try \"System\", \"Light\", or \"Dark\" modes.";
        let target = "Windows 目前支持 V2。Langnext 安全地使用 NSH 和 TSX。试试“跟随系统”、“浅色”或“深色”模式。";
        let pairs = align_blocks(source, &[Some(target.to_owned())]);

        let selected: Vec<(String, String)> = pairs
            .iter()
            .map(|p| {
                (
                    slice_utf16(source, p.source_start, p.source_end),
                    slice_utf16(target, p.target_start, p.target_end),
                )
            })
            .collect();
        assert_eq!(
            selected,
            vec![
                (
                    "Windows supports V2 right now.".to_owned(),
                    "Windows 目前支持 V2。".to_owned(),
                ),
                (
                    "Langnext uses NSH and TSX safely.".to_owned(),
                    "Langnext 安全地使用 NSH 和 TSX。".to_owned(),
                ),
                (
                    "Try \"System\", \"Light\", or \"Dark\" modes.".to_owned(),
                    "试试“跟随系统”、“浅色”或“深色”模式。".to_owned(),
                ),
            ]
        );
    }

    #[test]
    fn rejects_quote_anchor_without_literal_anchor_and_rejects_inverted_candidates() {
        // Without an accepted literal anchor elsewhere, a quote anchor alone does not align.
        let no_literal_src = "Intro sentence. Try \"System\" or \"Light\" mode.";
        let no_literal_tgt = "介绍句。尝试“系统”或“浅色”模式。";
        assert!(align_blocks(no_literal_src, &[Some(no_literal_tgt.to_owned())]).is_empty());

        // Non-anchor capitalized / lowercase / duplicate tokens never align.
        let weak_tokens_src = "Windows runs app. NSH helps one. NSH helps two.";
        let weak_tokens_tgt = "Windows 运行应用。NSH 帮助一。NSH 帮助二。";
        assert!(align_blocks(weak_tokens_src, &[Some(weak_tokens_tgt.to_owned())]).is_empty());

        // Inverted literal candidates do not align or fill gaps.
        let inverted_src = "NSH renders UI. Mid gap. TSX owns state.";
        let inverted_tgt = "TSX 管理状态。中间空档。NSH 渲染界面。";
        assert!(align_blocks(inverted_src, &[Some(inverted_tgt.to_owned())]).is_empty());

        // Conflicting literal candidates on the same sentence do not align or fill gaps.
        let conflict_src = "Use NSH and TSX. Gap tail.";
        let conflict_tgt = "使用 NSH。使用 TSX。尾部空档。";
        assert!(align_blocks(conflict_src, &[Some(conflict_tgt.to_owned())]).is_empty());

        // Quote candidate inverting an accepted literal anchor is ignored and does not fill gaps.
        let quote_invert_src = "Pick \"A\" or \"B\" here. Gap text. Use NSH cleanly.";
        let quote_invert_tgt = "干净地使用 NSH。空档文本。在此选择“A”或“B”。";
        let pairs = align_blocks(quote_invert_src, &[Some(quote_invert_tgt.to_owned())]);
        let selected: Vec<(String, String)> = pairs
            .iter()
            .map(|p| {
                (
                    slice_utf16(quote_invert_src, p.source_start, p.source_end),
                    slice_utf16(quote_invert_tgt, p.target_start, p.target_end),
                )
            })
            .collect();
        assert_eq!(
            selected,
            vec![("Use NSH cleanly.".to_owned(), "干净地使用 NSH。".to_owned(),)]
        );
    }

    #[test]
    fn fills_single_sentence_same_group_gaps_and_screenshot_paragraphs() {
        let between_src = "NSH starts. Middle gap fills here. TSX finishes.";
        let between_tgt = "NSH 起步。中间空档对齐。TSX 结束。";
        let between_pairs = align_blocks(between_src, &[Some(between_tgt.to_owned())]);
        let between_selected: Vec<(String, String)> = between_pairs
            .iter()
            .map(|p| {
                (
                    slice_utf16(between_src, p.source_start, p.source_end),
                    slice_utf16(between_tgt, p.target_start, p.target_end),
                )
            })
            .collect();
        assert_eq!(
            between_selected,
            vec![
                ("NSH starts.".to_owned(), "NSH 起步。".to_owned()),
                (
                    "Middle gap fills here.".to_owned(),
                    "中间空档对齐。".to_owned()
                ),
                ("TSX finishes.".to_owned(), "TSX 结束。".to_owned()),
            ]
        );

        let zh = "Langnext 是基于 NSH 构建的桌面应用。TSX 负责构建整个界面。\n\n初始界面包含语言、模型和外观设置。你可以在设置中选择“跟随系统”、“浅色”或“深色”。";
        let en = "Langnext is a desktop app built with NSH. TSX owns the entire interface.\n\nThe initial interface includes language, model, and appearance settings. You can pick \"System\", \"Light\", or \"Dark\" in settings.";
        let pairs = align_blocks(zh, &[Some(en.to_owned())]);
        let mapped: Vec<(String, String)> = pairs
            .iter()
            .map(|p| {
                (
                    slice_utf16(zh, p.source_start, p.source_end),
                    slice_utf16(en, p.target_start, p.target_end),
                )
            })
            .collect();
        assert_eq!(
            mapped,
            vec![
                (
                    "Langnext 是基于 NSH 构建的桌面应用。".to_owned(),
                    "Langnext is a desktop app built with NSH.".to_owned(),
                ),
                (
                    "TSX 负责构建整个界面。".to_owned(),
                    "TSX owns the entire interface.".to_owned(),
                ),
                (
                    "初始界面包含语言、模型和外观设置。".to_owned(),
                    "The initial interface includes language, model, and appearance settings."
                        .to_owned(),
                ),
                (
                    "你可以在设置中选择“跟随系统”、“浅色”或“深色”。".to_owned(),
                    "You can pick \"System\", \"Light\", or \"Dark\" in settings.".to_owned(),
                ),
            ]
        );
    }

    #[test]
    fn keeps_unanchored_equal_counts_unequal_gaps_and_unbounded_cross_group_gaps_unpaired() {
        // Unanchored equal-count text stays unpaired rather than matching by ordinal.
        assert!(
            align_blocks(
                "First unanchored. Second unanchored.",
                &[Some("第一句无锚点。第二句无锚点。".to_owned())],
            )
            .is_empty()
        );

        // Unequal gap between anchors or at group edges stays unpaired.
        let unequal_src = "NSH starts. Gap one. Gap two. TSX finishes.";
        let unequal_tgt = "NSH 起步。单一空档。TSX 结束。";
        let unequal_pairs = align_blocks(unequal_src, &[Some(unequal_tgt.to_owned())]);
        assert_eq!(unequal_pairs.len(), 2);

        // One anchor does not fill a gap across blank lines or excluded blocks.
        let cross_blank_src = "Before paragraph.\n\nNSH anchors here.";
        let cross_blank_tgt = "前一段。\n\n这里由 NSH 锚定。";
        let cross_blank = align_blocks(cross_blank_src, &[Some(cross_blank_tgt.to_owned())]);
        assert_eq!(cross_blank.len(), 1);
        assert_eq!(
            slice_utf16(
                cross_blank_src,
                cross_blank[0].source_start,
                cross_blank[0].source_end
            ),
            "NSH anchors here."
        );

        let cross_block_src = "Before sentence. NSH anchors here.";
        let cross_block = align_blocks(
            cross_block_src,
            &[
                Some("前一句。".to_owned()),
                None,
                Some("这里由 NSH 锚定。".to_owned()),
            ],
        );
        assert_eq!(cross_block.len(), 1);
        assert_eq!(cross_block[0].target_block_index, 2);

        let trailing_src = "NSH starts. Trailing gap fills.";
        let trailing_tgt = "NSH 起步。尾部空档对齐。";
        let trailing_pairs = align_blocks(trailing_src, &[Some(trailing_tgt.to_owned())]);
        assert_eq!(trailing_pairs.len(), 2);
        assert_eq!(
            slice_utf16(
                trailing_src,
                trailing_pairs[1].source_start,
                trailing_pairs[1].source_end
            ),
            "Trailing gap fills."
        );
        assert_eq!(
            slice_utf16(
                trailing_tgt,
                trailing_pairs[1].target_start,
                trailing_pairs[1].target_end
            ),
            "尾部空档对齐。"
        );
    }
}
