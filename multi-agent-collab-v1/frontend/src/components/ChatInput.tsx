import { useState, useRef, KeyboardEvent } from 'react';
import { useStore } from '../stores/useStore';
import { messagesApi, tasksApi } from '../api/client';
import { Send } from 'lucide-react';

export default function ChatInput() {
  const { agents, activeRoom, upsertMessage, upsertTask } = useStore();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [showAgentList, setShowAgentList] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    autoResize();

    const cursorPos = e.target.selectionStart || 0;
    const textBeforeCursor = val.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@(\S*)$/);

    if (atMatch) {
      setMentionFilter(atMatch[1]);
      setShowAgentList(true);
    } else {
      setShowAgentList(false);
    }
  };

  const insertMention = (name: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const cursorPos = el.selectionStart || 0;
    const textBeforeCursor = text.slice(0, cursorPos);
    const textAfterCursor = text.slice(cursorPos);
    const atIdx = textBeforeCursor.lastIndexOf('@');
    const newText = textBeforeCursor.slice(0, atIdx) + '@' + name + ' ' + textAfterCursor;
    setText(newText);
    setShowAgentList(false);
    setTimeout(() => {
      const newPos = atIdx + name.length + 2;
      el.setSelectionRange(newPos, newPos);
      el.focus();
    }, 0);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const filteredAgents = agents.filter(a =>
    a.name.toLowerCase().includes(mentionFilter.toLowerCase())
  );

  const sendMessage = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError('');
    setText('');

    // Check for /task command
    if (trimmed.startsWith('/task')) {
      try {
        const taskTitle = trimmed.replace('/task', '').trim();
        if (taskTitle) {
          const mentionMatch = taskTitle.match(/@(\S+)/);
          let assigneeId: number | undefined;
          let assigneeName = '';
          if (mentionMatch) {
            const agent = agents.find(a => a.name === mentionMatch[1]);
            assigneeId = agent?.id;
            assigneeName = agent?.name || '';
          }
          const cleanTitle = taskTitle.replace(/@\S+\s*/, '');
          const task = await tasksApi.create({
            title: cleanTitle,
            status: 'todo',
            assignee_id: assigneeId,
            priority: 'medium',
          });
          upsertTask(task);
          const msg = await messagesApi.create({
            agent_name: '系统',
            role: '系统',
            action: 'task.created',
            target: assigneeName || 'all',
            room: activeRoom === 'group' ? 'group' : activeRoom,
            content: `已创建任务：${cleanTitle}${assigneeName ? ' → @' + assigneeName : ''}`,
            deliverables: [cleanTitle],
            next_steps: assigneeName ? [`@${assigneeName} 请开始任务`] : [],
          });
          upsertMessage(msg);
        }
      } catch (e) {
        setError('任务创建失败，请检查后端是否启动');
        setText(trimmed);
      } finally {
        setSending(false);
      }
      return;
    }

    // Regular message
    let room = 'group';
    let target = 'all';
    let agentName = '用户';
    let agentId: number | undefined;

    if (activeRoom !== 'group') {
      const agentIdFromRoom = activeRoom.replace('agent_', '');
      const agent = agents.find(a => String(a.id) === agentIdFromRoom);
      if (agent) {
        room = `agent_${agent.id}`;
        target = agent.name;
        agentName = '用户';
        agentId = undefined;
      }
    }

    // Extract @mentions in group chat
    if (room === 'group') {
      const mentions = trimmed.match(/@(\S+)/g);
      if (mentions && mentions.length > 0) {
        const mentionedName = mentions[0].replace('@', '');
        const mentionedAgent = agents.find(a => a.name === mentionedName);
        if (mentionedAgent) {
          target = mentionedAgent.name;
        }
      }
    }

    try {
      const msg = await messagesApi.create({
        agent_name: agentName,
        agent_id: agentId,
        role: '用户',
        action: 'message',
        target,
        room,
        content: trimmed,
        deliverables: [],
        next_steps: [],
      });
      upsertMessage(msg);
    } catch (e) {
      setError('发送失败，请检查后端是否启动');
      setText(trimmed);
    } finally {
      setSending(false);
      autoResize();
    }
  };

  return (
    <div className="border-t border-gray-100 px-4 py-3 bg-white">
      {showAgentList && filteredAgents.length > 0 && (
        <div className="mb-2 bg-white border rounded-lg shadow-lg max-h-32 overflow-y-auto">
          {filteredAgents.map((a) => (
            <button
              key={a.id}
              onClick={() => insertMention(a.name)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 flex items-center gap-2"
            >
              <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center text-[10px] font-bold">
                {a.name[0]}
              </span>
              {a.name}
              <span className="text-[10px] text-slate-400 ml-auto">{a.role}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={`${activeRoom === 'group' ? '输入消息或 /task 创建任务，使用 @ 提及智能体...' : '输入消息...'}`}
            className="w-full border-none rounded-xl bg-gray-50 px-4 py-2.5 text-sm outline-none focus:bg-gray-100 transition-colors resize-none"
          />
        </div>
        <button
          onClick={sendMessage}
          disabled={!text.trim() || sending}
          className="w-9 h-9 rounded-full bg-indigo-500 text-white flex items-center justify-center hover:bg-indigo-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex-shrink-0"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>

      <div className="mt-2 flex gap-3 text-[10px] text-slate-400">
        {sending && <span className="text-indigo-500">发送中...</span>}
        {error && <span className="text-red-500">{error}</span>}
        <span>Enter 发送</span>
        <span>Shift+Enter 换行</span>
        <span>@ 提及</span>
        <span>/task 创建任务</span>
      </div>
    </div>
  );
}
