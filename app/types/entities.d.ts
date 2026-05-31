export interface User {
  id: string
  username: string
  avatar: string
}

export interface AuthenticatedUser extends User {
  session: null
}
