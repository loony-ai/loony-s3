const API_URL = (import.meta.env['VITE_API_URL'] as string | undefined) ?? '';

function getToken(): string | null {
  try {
    const raw = localStorage.getItem('loony-s3-auth');
    if (!raw) return null;
    return (JSON.parse(raw) as { state?: { token?: string } }).state?.token ?? null;
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  rawBody?: BodyInit;
  skipContentType?: boolean;
  onProgress?: (pct: number) => void;
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = getToken();
  const { body, rawBody, skipContentType, onProgress: _onProgress, ...rest } = opts;

  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined && !skipContentType) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_URL}${path}`, {
    ...rest,
    headers: { ...headers, ...(rest.headers as Record<string, string> | undefined) },
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg =
      (data as { error?: { message?: string } })?.error?.message ??
      (typeof data === 'string' ? data : res.statusText);
    throw new ApiError(res.status, msg);
  }

  return data as T;
}

export async function uploadFile(
  path: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API_URL}${path}`);

    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('Content-Length', String(file.size));

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          resolve(xhr.responseText);
        }
      } else {
        try {
          const err = JSON.parse(xhr.responseText);
          reject(new ApiError(xhr.status, err?.error?.message ?? xhr.statusText));
        } catch {
          reject(new ApiError(xhr.status, xhr.statusText));
        }
      }
    };

    xhr.onerror = () => reject(new ApiError(0, 'Network error'));
    xhr.send(file);
  });
}
