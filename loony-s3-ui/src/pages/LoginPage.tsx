import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Database } from 'lucide-react';
import { login } from '@/api/auth';
import { useAuthStore } from '@/store/useAuthStore';
import { useToast } from '@/context/ToastContext';
import { Spinner } from '@/components/Spinner';
import { ApiError } from '@/api/client';

export function LoginPage() {
  const [userId, setUserId] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const { login: storeLogin } = useAuthStore();
  const navigate = useNavigate();
  const toast = useToast();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!userId.trim() || !name.trim()) return;

    setLoading(true);
    try {
      const { token } = await login(userId.trim(), name.trim());
      storeLogin(userId.trim(), name.trim(), token);
      navigate('/');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Login failed';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-blue-600 rounded-2xl mb-4 shadow-lg shadow-blue-200">
            <Database className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Loony S3</h1>
          <p className="text-sm text-gray-500 mt-1">Object Storage Dashboard</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="userId" className="block text-sm font-medium text-gray-700 mb-1.5">
                User ID
              </label>
              <input
                id="userId"
                type="text"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="e.g. user-123"
                required
                className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
              />
            </div>

            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1.5">
                Display Name
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Alice"
                required
                className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
              />
            </div>

            <button
              type="submit"
              disabled={loading || !userId.trim() || !name.trim()}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {loading ? <Spinner size="sm" /> : null}
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="mt-4 text-xs text-center text-gray-400">
            No password required — identity-based access
          </p>
        </div>
      </div>
    </div>
  );
}
