import { useCallback, useRef } from 'react';
import { isFocusedInsideEnhancedInput } from '@/lib/focus';
import { useAgentSessionsStore } from '@/stores/agentSessions';

interface FocusReturnState {
  sessionId: string | null;
  shouldRestore: boolean;
}

export function useFocusReturn(sessionId: string | null) {
  const getEnhancedInputState = useAgentSessionsStore((state) => state.getEnhancedInputState);
  const requestEnhancedInputFocus = useAgentSessionsStore(
    (state) => state.requestEnhancedInputFocus
  );
  const consumeEnhancedInputBlurToken = useAgentSessionsStore(
    (state) => state.consumeEnhancedInputBlurToken
  );
  const clearEnhancedInputBlurToken = useAgentSessionsStore(
    (state) => state.clearEnhancedInputBlurToken
  );
  const transitionEnhancedInputFocusState = useAgentSessionsStore(
    (state) => state.transitionEnhancedInputFocusState
  );
  const focusReturnRef = useRef<FocusReturnState>({
    sessionId: null,
    shouldRestore: false,
  });

  const captureFromPointer = useCallback(() => {
    focusReturnRef.current = { sessionId, shouldRestore: false };
    if (!sessionId) return;

    const enhancedInputState = getEnhancedInputState(sessionId);
    const shouldRestore = enhancedInputState.open && isFocusedInsideEnhancedInput(sessionId);

    focusReturnRef.current = { sessionId, shouldRestore };
    if (shouldRestore) {
      clearEnhancedInputBlurToken(sessionId);
      transitionEnhancedInputFocusState(sessionId, 'overlay-open');
    }
  }, [
    clearEnhancedInputBlurToken,
    getEnhancedInputState,
    sessionId,
    transitionEnhancedInputFocusState,
  ]);

  const captureFallback = useCallback(() => {
    focusReturnRef.current = { sessionId, shouldRestore: false };
    if (!sessionId) return;

    const enhancedInputState = getEnhancedInputState(sessionId);
    focusReturnRef.current = {
      sessionId,
      shouldRestore:
        enhancedInputState.open &&
        (isFocusedInsideEnhancedInput(sessionId) || consumeEnhancedInputBlurToken(sessionId)),
    };
    if (focusReturnRef.current.shouldRestore) {
      transitionEnhancedInputFocusState(sessionId, 'overlay-open');
    }
  }, [
    consumeEnhancedInputBlurToken,
    getEnhancedInputState,
    sessionId,
    transitionEnhancedInputFocusState,
  ]);

  const restore = useCallback(() => {
    const { sessionId: targetSessionId, shouldRestore } = focusReturnRef.current;
    focusReturnRef.current = { sessionId: null, shouldRestore: false };
    clearEnhancedInputBlurToken(targetSessionId ?? undefined);
    if (targetSessionId) {
      transitionEnhancedInputFocusState(targetSessionId, 'overlay-close');
    }

    if (!shouldRestore || !targetSessionId) return;

    setTimeout(() => {
      requestEnhancedInputFocus(targetSessionId);
    }, 0);
  }, [clearEnhancedInputBlurToken, requestEnhancedInputFocus, transitionEnhancedInputFocusState]);

  return { captureFromPointer, captureFallback, restore };
}
