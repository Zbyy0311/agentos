'use client';

import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ConversationMessage } from '@agentos/shared';

export function VirtualMessageList({ messages, scrollElementRef, renderMessage }: {
  messages: readonly ConversationMessage[];
  scrollElementRef: React.RefObject<HTMLElement>;
  renderMessage(message: ConversationMessage): React.ReactNode;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => 120,
    overscan: 8,
    measureElement: element => element.getBoundingClientRect().height,
  });
  useEffect(() => { virtualizer.measure(); }, [messages.length, virtualizer]);
  return <div ref={measureRef} className="relative" style={{ height: `${virtualizer.getTotalSize()}px` }}>
    {virtualizer.getVirtualItems().map(item => <div key={messages[item.index].id} data-index={item.index} ref={virtualizer.measureElement} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${item.start}px)` }}>
      {renderMessage(messages[item.index])}
    </div>)}
  </div>;
}

