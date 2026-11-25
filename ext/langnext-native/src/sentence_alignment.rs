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
        for (rel_start, segment) in slice.split_sentence_bound_indices() {
            let leading_ws = segment.len() - segment.trim_start().len();
            let trailing_trimmed = segment.trim_end();
            if trailing_trimmed.len() <= leading_ws {
                continue;
            }
            let trimmed = &segment[leading_ws..trailing_trimmed.len()];
            if !is_sentence_candidate(trimmed) {
                continue;
            }
            let abs_start = group_start + rel_start + leading_ws;
            let abs_end = group_start + rel_start + trailing_trimmed.len();
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

fn for_each_literal_anchor_token<'a>(text: &'a str, mut visit: impl FnMut(&'a str)) {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let token = &text[start..i];
            if is_literal_anchor_token(token) {
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

fn collect_literal_anchors(
    source_sentences: &[Sentence<'_>],
    target_sentences: &[Sentence<'_>],
) -> Vec<(usize, usize)> {
    let mut occurrences: HashMap<&str, (UniqueSentence, UniqueSentence)> = HashMap::new();
    for (idx, sentence) in source_sentences.iter().enumerate() {
        for_each_literal_anchor_token(sentence.text, |token| {
            occurrences.entry(token).or_default().0.record(idx);
        });
    }
    for (idx, sentence) in target_sentences.iter().enumerate() {
        for_each_literal_anchor_token(sentence.text, |token| {
            occurrences.entry(token).or_default().1.record(idx);
        });
    }

    let mut candidates: Vec<(usize, usize)> = occurrences
        .into_values()
        .filter_map(|(src, tgt)| Some((src.index()?, tgt.index()?)))
        .collect();
    filter_non_conflicting_monotonic(&mut candidates);
    candidates
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

fn fill_same_group_gaps(
    accepted: &[(usize, usize)],
    source_sentences: &[Sentence<'_>],
    source_groups: &[GroupSpan],
    target_sentences: &[Sentence<'_>],
    target_groups: &[GroupSpan],
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
        if source_sentences[s_a].group_id == source_sentences[s_b].group_id
            && target_sentences[t_a].group_id == target_sentences[t_b].group_id
            && s_b - s_a == 2
            && t_b - t_a == 2
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

    let literal_anchors = collect_literal_anchors(&source_sentences, &target_sentences);
    let quote_anchors =
        collect_quote_anchors(&source_sentences, &target_sentences, &literal_anchors);

    let mut accepted = literal_anchors;
    accepted.extend(quote_anchors);
    accepted.sort_unstable();
    accepted.dedup();

    let paired = fill_same_group_gaps(
        &accepted,
        &source_sentences,
        &source_groups,
        &target_sentences,
        &target_groups,
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
    fn keeps_unanchored_equal_count_unequal_gaps_and_cross_group_sentences_unpaired() {
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

        // Cross-group gaps (across blank lines or target block boundaries) never fill.
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
