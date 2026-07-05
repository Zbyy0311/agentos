import { useStore } from '../stores/useStore';
import { filesApi } from '../api/client';
import { Folder, FileCode, GitCommit, Save } from 'lucide-react';
import { useState } from 'react';

export default function RepoView() {
  const files = useStore((s) => s.files);
  const selectedFile = useStore((s) => s.selectedFile);
  const setSelectedFile = useStore((s) => s.setSelectedFile);
  const [editContent, setEditContent] = useState('');

  const tree: Record<string, (typeof files)[number][]> = {};
  files.forEach((file) => {
    const dir = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : 'root';
    tree[dir] = tree[dir] || [];
    tree[dir].push(file);
  });

  const openFile = (file: (typeof files)[number]) => {
    setSelectedFile(file);
    setEditContent(file.content || '');
  };

  const saveFile = async () => {
    if (!selectedFile) return;
    await filesApi.upsert({ path: selectedFile.path, content: editContent, agent_name: 'Codex' });
  };

  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="flex items-center gap-2 mb-3">
        <Folder className="w-4 h-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-700">代码仓库视图</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 h-64">
        <div className="md:col-span-1 border rounded-lg overflow-y-auto p-2">
          {Object.entries(tree).map(([dir, dirFiles]) => (
            <div key={dir}>
              <div className="text-[10px] font-semibold text-slate-400 uppercase px-1 py-1">{dir}</div>
              {dirFiles.map((file) => (
                <button
                  key={file.id}
                  onClick={() => openFile(file)}
                  className={`w-full text-left text-xs px-2 py-1 rounded flex items-center gap-1 ${
                    selectedFile?.id === file.id ? 'bg-indigo-50 text-indigo-700' : 'hover:bg-slate-50'
                  }`}
                >
                  <FileCode className="w-3 h-3" />
                  {file.path.split('/').pop()}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="md:col-span-2 border rounded-lg p-2 flex flex-col">
          {selectedFile ? (
            <>
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-medium flex items-center gap-1">
                  <GitCommit className="w-3 h-3" />
                  {selectedFile.path} · v{selectedFile.version}
                </div>
                <button
                  onClick={saveFile}
                  className="text-xs bg-indigo-600 text-white px-2 py-1 rounded flex items-center gap-1"
                >
                  <Save className="w-3 h-3" /> 保存
                </button>
              </div>
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="flex-1 w-full text-xs font-mono p-2 border rounded resize-none"
              />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-slate-400">选择文件查看/编辑</div>
          )}
        </div>
      </div>
    </div>
  );
}
