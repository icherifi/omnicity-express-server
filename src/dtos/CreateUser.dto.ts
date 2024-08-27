//Data should be validated by middleware before it reaches the controller

export interface CreateUserDto {
  username: string;
  email: string;
  password: string;
}