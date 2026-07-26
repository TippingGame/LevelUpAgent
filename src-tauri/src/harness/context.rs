//! Context selection and compaction invariants adapted from jcode's
//! `jcode-compaction-core` (MIT). This module intentionally does not depend on
//! a provider tokenizer or on jcode message types.

use std::collections::{HashMap, HashSet};

use super::types::{ContextBlock, ContextBudget, ContextSelection};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageUnit {
    pub id: String,
    pub tool_use_ids: Vec<String>,
    pub tool_result_ids: Vec<String>,
}

pub fn estimate_tokens(text: &str, chars_per_token: u32) -> u32 {
    let divisor = chars_per_token.max(1) as usize;
    let chars = text.chars().count();
    chars.saturating_add(divisor - 1).saturating_div(divisor) as u32
}

pub fn truncate_utf8(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

pub fn select_blocks(blocks: &[ContextBlock], budget: &ContextBudget) -> ContextSelection {
    let capacity = budget
        .input_capacity()
        .saturating_sub(budget.fixed_tokens());
    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    let mut order = Vec::new();
    for (index, block) in blocks.iter().enumerate() {
        let group = block
            .group_id
            .clone()
            .unwrap_or_else(|| format!("__block:{}", block.id));
        if !groups.contains_key(&group) {
            order.push(group.clone());
        }
        groups.entry(group).or_default().push(index);
    }

    let mut result = ContextSelection::default();
    let mut selected_groups = HashSet::new();
    for group in order {
        if !selected_groups.insert(group.clone()) {
            continue;
        }
        let indexes = &groups[&group];
        let cost = indexes.iter().fold(0u32, |sum, index| {
            sum.saturating_add(blocks[*index].estimated_tokens)
        });
        let mandatory = indexes.iter().any(|index| blocks[*index].mandatory);
        if mandatory || result.estimated_tokens.saturating_add(cost) <= capacity {
            for index in indexes {
                result.selected_ids.push(blocks[*index].id.clone());
            }
            result.estimated_tokens = result.estimated_tokens.saturating_add(cost);
            if result.estimated_tokens > capacity {
                result.overflow = true;
            }
        } else {
            for index in indexes {
                result.omitted_ids.push(blocks[*index].id.clone());
            }
        }
    }
    result
}

/// Returns the first retained message index for a suffix compaction.
///
/// A suffix may not contain a tool result whose matching call was compacted
/// away. If a complete pair cannot be recovered, returning zero is the safe
/// choice: the caller must not compact this history automatically.
pub fn safe_compaction_cutoff(messages: &[MessageUnit], initial_cutoff: usize) -> usize {
    let mut cutoff = initial_cutoff.min(messages.len());
    let mut available_tool_ids = HashSet::new();
    let mut missing_tool_ids = HashSet::new();

    for message in &messages[cutoff..] {
        for id in &message.tool_use_ids {
            available_tool_ids.insert(id.clone());
            missing_tool_ids.remove(id);
        }
        for id in &message.tool_result_ids {
            if !available_tool_ids.contains(id) {
                missing_tool_ids.insert(id.clone());
            }
        }
    }
    if missing_tool_ids.is_empty() {
        return cutoff;
    }

    for index in (0..cutoff).rev() {
        let message = &messages[index];
        for id in &message.tool_use_ids {
            available_tool_ids.insert(id.clone());
            missing_tool_ids.remove(id);
        }
        for id in &message.tool_result_ids {
            if !available_tool_ids.contains(id) {
                missing_tool_ids.insert(id.clone());
            }
        }
        if missing_tool_ids.is_empty() {
            cutoff = index;
            return cutoff;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::types::{ContextInclusion, TrustLevel};

    fn block(id: &str, tokens: u32, group_id: Option<&str>, mandatory: bool) -> ContextBlock {
        ContextBlock {
            id: id.to_owned(),
            source_kind: "test".to_owned(),
            content_hash: id.to_owned(),
            estimated_tokens: tokens,
            trust: TrustLevel::User,
            inclusion: ContextInclusion::Include,
            group_id: group_id.map(str::to_owned),
            mandatory,
        }
    }

    #[test]
    fn selection_keeps_tool_groups_atomic() {
        let budget = ContextBudget {
            context_window: 100,
            reserve_output_tokens: 10,
            safety_margin_tokens: 10,
            system_tokens: 0,
            instruction_tokens: 0,
            tool_schema_tokens: 0,
            message_tokens: 0,
            attachment_tokens: 0,
            memory_tokens: 0,
        };
        let result = select_blocks(
            &[
                block("call", 30, Some("tool-1"), false),
                block("result", 30, Some("tool-1"), false),
                block("old", 40, None, false),
            ],
            &budget,
        );
        assert_eq!(result.selected_ids, vec!["call", "result"]);
        assert_eq!(result.omitted_ids, vec!["old"]);
    }

    #[test]
    fn mandatory_current_input_reports_overflow_instead_of_dropping_it() {
        let budget = ContextBudget {
            context_window: 20,
            reserve_output_tokens: 5,
            safety_margin_tokens: 5,
            system_tokens: 0,
            instruction_tokens: 0,
            tool_schema_tokens: 0,
            message_tokens: 0,
            attachment_tokens: 0,
            memory_tokens: 0,
        };
        let result = select_blocks(&[block("current", 20, None, true)], &budget);
        assert!(result.overflow);
        assert_eq!(result.selected_ids, vec!["current"]);
    }

    #[test]
    fn safe_cutoff_retains_matching_tool_use() {
        let messages = vec![
            MessageUnit {
                id: "old".into(),
                tool_use_ids: vec!["call-1".into()],
                tool_result_ids: vec![],
            },
            MessageUnit {
                id: "result".into(),
                tool_use_ids: vec![],
                tool_result_ids: vec!["call-1".into()],
            },
            MessageUnit {
                id: "recent".into(),
                tool_use_ids: vec![],
                tool_result_ids: vec![],
            },
        ];
        assert_eq!(safe_compaction_cutoff(&messages, 1), 0);
    }

    #[test]
    fn utf8_truncation_never_splits_a_codepoint() {
        assert_eq!(truncate_utf8("你好世界", 5), "你");
        assert_eq!(estimate_tokens("你好世界", 4), 1);
    }
}
