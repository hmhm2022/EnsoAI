import { memo } from 'react';
import type { EnhancedInputCloseReason } from '@/lib/focusPolicy';
import { useAgentSessionsStore } from '@/stores/agentSessions';
import { useSettingsStore } from '@/stores/settings';
import { EnhancedInput } from './EnhancedInput';

interface EnhancedInputContainerProps {
  sessionId: string;
  onOpenChange: (open: boolean, reason?: EnhancedInputCloseReason) => void;
  onSend: (content: string, imagePaths: string[]) => void;
  /** Whether the parent panel is active (used to trigger focus on tab switch) */
  isActive?: boolean;
}

/**
 * Container component for EnhancedInput that subscribes to its own state.
 * This prevents re-renders of the parent AgentPanel when enhanced input state changes.
 */
export const EnhancedInputContainer = memo(function EnhancedInputContainer({
  sessionId,
  onOpenChange,
  onSend,
  isActive = false,
}: EnhancedInputContainerProps) {
  // Subscribe to only this session's enhanced input state
  const enhancedInputState = useAgentSessionsStore((state) => state.enhancedInputStates[sessionId]);
  const setEnhancedInputContent = useAgentSessionsStore((state) => state.setEnhancedInputContent);
  const setEnhancedInputImages = useAgentSessionsStore((state) => state.setEnhancedInputImages);
  const clearEnhancedInput = useAgentSessionsStore((state) => state.clearEnhancedInput);
  const focusRequestKey = useAgentSessionsStore(
    (state) => state.enhancedInputFocusKeys[sessionId] ?? 0
  );
  const markEnhancedInputBlurred = useAgentSessionsStore((state) => state.markEnhancedInputBlurred);
  const clearEnhancedInputBlurToken = useAgentSessionsStore(
    (state) => state.clearEnhancedInputBlurToken
  );
  const transitionEnhancedInputFocusState = useAgentSessionsStore(
    (state) => state.transitionEnhancedInputFocusState
  );

  // Get enhanced input mode setting
  const enhancedInputAutoPopup = useSettingsStore(
    (state) => state.claudeCodeIntegration.enhancedInputAutoPopup
  );
  const keepOpenAfterSend = enhancedInputAutoPopup === 'always';

  // Get cwd from session for file mention search
  const cwd = useAgentSessionsStore((state) => state.sessions.find((s) => s.id === sessionId)?.cwd);

  // Default state if not found
  const open = enhancedInputState?.open ?? false;
  const content = enhancedInputState?.content ?? '';
  const imagePaths = enhancedInputState?.imagePaths ?? [];

  if (!open) return null;

  return (
    <EnhancedInput
      open
      onOpenChange={onOpenChange}
      onSend={(sendContent, sendImagePaths) => {
        console.log('[EnhancedInput] Sending message');
        onSend(sendContent, sendImagePaths);
        clearEnhancedInput(sessionId, keepOpenAfterSend);
      }}
      sessionId={sessionId}
      focusRequestKey={focusRequestKey}
      onFocusEnter={() => {
        clearEnhancedInputBlurToken(sessionId);
        transitionEnhancedInputFocusState(sessionId, 'enhanced-focus');
      }}
      onFocusLeave={() => markEnhancedInputBlurred(sessionId)}
      content={content}
      imagePaths={imagePaths}
      onContentChange={(newContent) => setEnhancedInputContent(sessionId, newContent)}
      onImagesChange={(newImagePaths) => setEnhancedInputImages(sessionId, newImagePaths)}
      keepOpenAfterSend={keepOpenAfterSend}
      isActive={isActive}
      cwd={cwd}
    />
  );
});
