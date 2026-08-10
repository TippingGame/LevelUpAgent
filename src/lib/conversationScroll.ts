export const CONVERSATION_BOTTOM_THRESHOLD = 96;

export interface ConversationScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function isConversationNearBottom(
  metrics: ConversationScrollMetrics,
  threshold = CONVERSATION_BOTTOM_THRESHOLD,
) {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function shouldFollowConversationUpdate(isFollowing: boolean, userMessageAdded: boolean) {
  return isFollowing || userMessageAdded;
}
