/**
 * The users routes of docs/web-interfaces.md, U. Administrators only, all four.
 *
 * The server decides what is allowed and says why in the message: the last administrator
 * cannot be demoted, disabled or deleted, and nobody can delete themselves. Nothing is
 * checked twice here -- a rule written in two places is a rule that drifts.
 */
import { type Complete, type Optional, type Schemas, api } from './client';
import type { Role, User } from './auth';

export type UserList = Omit<Complete<Schemas['UserList']>, 'users'> & { users: User[] };

/** `POST /api/users`; `role` defaults to `member` on the server. */
export type NewUser = Omit<Optional<Schemas['NewUser'], 'role'>, 'role'> & { role?: Role };

/** `PUT /api/users/{id}`: a role, a disabled flag, a new password, or any two of them. */
export type UserChange = Omit<Schemas['UserChange'], 'role'> & { role?: Role | null };

export const listUsers = () => api.get<UserList>('/users');

export const createUser = (body: NewUser) => api.post<User>('/users', body);

export const updateUser = (id: number, body: UserChange) => api.put<User>(`/users/${id}`, body);

export const deleteUser = (id: number) => api.delete<Schemas['Ok']>(`/users/${id}`);
