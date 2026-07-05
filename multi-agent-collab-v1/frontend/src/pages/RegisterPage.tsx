import { useState, FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { clsx } from 'clsx';
import { Loader2, Eye, EyeOff, Lock, User, Mail, AlertCircle, CheckCircle } from 'lucide-react';

interface RegisterForm {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
}

interface FormErrors {
  username?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
  general?: string;
}

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export default function RegisterPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState<RegisterForm>({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [success, setSuccess] = useState(false);

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};

    if (!form.username.trim()) {
      newErrors.username = '请输入用户名';
    } else if (form.username.length < 3) {
      newErrors.username = '用户名至少3个字符';
    }

    if (!form.email.trim()) {
      newErrors.email = '请输入邮箱';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      newErrors.email = '请输入有效的邮箱地址';
    }

    if (!form.password) {
      newErrors.password = '请输入密码';
    } else if (form.password.length < 8) {
      newErrors.password = '密码长度至少8位';
    }

    if (!form.confirmPassword) {
      newErrors.confirmPassword = '请确认密码';
    } else if (form.password !== form.confirmPassword) {
      newErrors.confirmPassword = '两次输入的密码不一致';
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
      const response = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.username,
          email: form.email,
          password: form.password,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || '注册失败，请稍后重试');
      }

      setSuccess(true);
      setTimeout(() => navigate('/login'), 2000);
    } catch (err) {
      setErrors({
        general: err instanceof Error ? err.message : '网络错误，请稍后重试',
      });
    } finally {
      setLoading(false);
    }
  };

  const updateField = (field: keyof RegisterForm, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-green-100 rounded-2xl mb-4">
            <CheckCircle className="w-8 h-8 text-green-600" />
          </div>
          <h2 className="text-xl font-bold text-slate-800 mb-2">注册成功！</h2>
          <p className="text-slate-500">正在跳转到登录页面...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-indigo-100 rounded-2xl mb-4">
              <User className="w-8 h-8 text-indigo-600" />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">创建账号</h1>
            <p className="text-slate-500 mt-2">加入 Multi-Agent 协作平台</p>
          </div>

          {errors.general && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
              <p className="text-sm text-red-600">{errors.general}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                用户名
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  type="text"
                  value={form.username}
                  onChange={(e) => updateField('username', e.target.value)}
                  className={clsx(
                    'w-full pl-10 pr-4 py-2.5 border rounded-xl transition-all',
                    'focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500',
                    errors.username ? 'border-red-300 bg-red-50' : 'border-slate-200 hover:border-slate-300'
                  )}
                  placeholder="请输入用户名"
                  disabled={loading}
                />
              </div>
              {errors.username && (
                <p className="mt-1 text-sm text-red-500">{errors.username}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                邮箱
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => updateField('email', e.target.value)}
                  className={clsx(
                    'w-full pl-10 pr-4 py-2.5 border rounded-xl transition-all',
                    'focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500',
                    errors.email ? 'border-red-300 bg-red-50' : 'border-slate-200 hover:border-slate-300'
                  )}
                  placeholder="请输入邮箱"
                  disabled={loading}
                />
              </div>
              {errors.email && (
                <p className="mt-1 text-sm text-red-500">{errors.email}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                密码
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={(e) => updateField('password', e.target.value)}
                  className={clsx(
                    'w-full pl-10 pr-12 py-2.5 border rounded-xl transition-all',
                    'focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500',
                    errors.password ? 'border-red-300 bg-red-50' : 'border-slate-200 hover:border-slate-300'
                  )}
                  placeholder="至少8位"
                  disabled={loading}
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
                <p className="mt-1 text-sm text-red-500">{errors.password}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                确认密码
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  type="password"
                  value={form.confirmPassword}
                  onChange={(e) => updateField('confirmPassword', e.target.value)}
                  className={clsx(
                    'w-full pl-10 pr-4 py-2.5 border rounded-xl transition-all',
                    'focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500',
                    errors.confirmPassword ? 'border-red-300 bg-red-50' : 'border-slate-200 hover:border-slate-300'
                  )}
                  placeholder="再次输入密码"
                  disabled={loading}
                />
              </div>
              {errors.confirmPassword && (
                <p className="mt-1 text-sm text-red-500">{errors.confirmPassword}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              className={clsx(
                'w-full py-2.5 px-4 rounded-xl font-medium transition-all',
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
                  注册中...
                </span>
              ) : (
                '注 册'
              )}
            </button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-sm text-slate-500">
              已有账号？{' '}
              <Link to="/login" className="text-indigo-600 hover:text-indigo-700 font-medium">
                立即登录
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
