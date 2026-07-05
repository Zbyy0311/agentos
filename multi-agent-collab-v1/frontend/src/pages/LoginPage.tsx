import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { Loader2, Eye, EyeOff, Lock, User, AlertCircle } from 'lucide-react';

interface LoginForm {
  username: string;
  password: string;
  captcha?: string;
}

interface FormErrors {
  username?: string;
  password?: string;
  captcha?: string;
  general?: string;
}

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export default function LoginPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState<LoginForm>({ username: '', password: '' });
  const [errors, setErrors] = useState<FormErrors>({});
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};

    if (!form.username.trim()) {
      newErrors.username = '请输入用户名';
    }

    if (!form.password) {
      newErrors.password = '请输入密码';
    } else if (form.password.length < 8) {
      newErrors.password = '密码长度至少8位';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!validateForm()) return;

    setLoading(true);
    setErrors({});

    try {
      const response = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.username,
          password: form.password,
          ...(form.captcha && { captcha: form.captcha }),
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || '登录失败，请检查用户名和密码');
      }

      const data = await response.json();
      localStorage.setItem('token', data.access_token);
      localStorage.setItem('token_expires', String(Date.now() + data.expires_in * 1000));

      navigate('/');
    } catch (err) {
      setErrors({
        general: err instanceof Error ? err.message : '网络错误，请稍后重试',
      });
    } finally {
      setLoading(false);
    }
  };

  const updateField = (field: keyof LoginForm, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-indigo-100 rounded-2xl mb-4">
              <Lock className="w-8 h-8 text-indigo-600" />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">Multi-Agent 协作平台</h1>
            <p className="text-slate-500 mt-2">登录以继续</p>
          </div>

          {errors.general && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
              <p className="text-sm text-red-600">{errors.general}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                用户名
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  type="text"
                  value={form.username}
                  onChange={(e) => updateField('username', e.target.value)}
                  className={clsx(
                    'w-full pl-10 pr-4 py-3 border rounded-xl transition-all',
                    'focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500',
                    errors.username ? 'border-red-300 bg-red-50' : 'border-slate-200 hover:border-slate-300'
                  )}
                  placeholder="请输入用户名"
                  disabled={loading}
                  autoComplete="username"
                />
              </div>
              {errors.username && (
                <p className="mt-1.5 text-sm text-red-500">{errors.username}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                密码
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={(e) => updateField('password', e.target.value)}
                  className={clsx(
                    'w-full pl-10 pr-12 py-3 border rounded-xl transition-all',
                    'focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500',
                    errors.password ? 'border-red-300 bg-red-50' : 'border-slate-200 hover:border-slate-300'
                  )}
                  placeholder="请输入密码"
                  disabled={loading}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
              {errors.password && (
                <p className="mt-1.5 text-sm text-red-500">{errors.password}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              className={clsx(
                'w-full py-3 px-4 rounded-xl font-medium transition-all',
                'focus:outline-none focus:ring-2 focus:ring-indigo-500/20',
                loading
                  ? 'bg-indigo-400 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800',
                'text-white'
              )}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  登录中...
                </span>
              ) : (
                '登 录'
              )}
            </button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-sm text-slate-500">
              还没有账号？{' '}
              <a href="/register" className="text-indigo-600 hover:text-indigo-700 font-medium">
                立即注册
              </a>
            </p>
          </div>
        </div>

        <p className="text-center text-xs text-slate-400 mt-6">
          Multi-Agent Collaboration Platform v1.0
        </p>
      </div>
    </div>
  );
}
