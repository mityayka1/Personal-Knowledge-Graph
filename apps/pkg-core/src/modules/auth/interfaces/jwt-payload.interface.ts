export interface JwtPayload {
  sub: string; // user id
  username: string;
  role: string;
  type: 'access' | 'refresh';
  iat?: number;
  exp?: number;
  jti?: string; // token id for refresh token tracking
}

export interface TokenResponse {
  accessToken: string;
  expiresIn: number;
}

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: string;
}
