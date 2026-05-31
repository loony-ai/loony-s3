import { request } from './client';

export interface TokenResponse {
  token: string;
  api_key: string;
}

export function login(userId: string, name: string): Promise<TokenResponse> {
  return request<TokenResponse>('/auth/token', {
    method: 'POST',
    body: { user_id: userId, name },
  });
}
