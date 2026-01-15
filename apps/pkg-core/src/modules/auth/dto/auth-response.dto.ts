export class AuthResponseDto {
  accessToken: string;
  expiresIn: number;
}

export class UserResponseDto {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  role: string;
}
