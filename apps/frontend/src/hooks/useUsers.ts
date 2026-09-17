import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RoleSummary, UserWithRoles, UserInvitation } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';

export function useUsersList(page: number, pageSize = 20) {
  return useQuery({
    queryKey: ['users', page, pageSize],
    queryFn: () => api.getPage<UserWithRoles[]>(`/users?page=${page}&page_size=${pageSize}`),
  });
}

export function useInvitations() {
  return useQuery({
    queryKey: ['invitations'],
    queryFn: () => api.get<(UserInvitation & { role_name: string | null })[]>('/users/invitations'),
  });
}

export function useInviteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; role_id: string }) => api.post('/users', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invitations'] });
    },
  });
}

export function useRevokeInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/users/invitations/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invitations'] }),
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...input
    }: {
      id: string;
      full_name?: string;
      role_id?: string;
      status?: 'active' | 'inactive';
    }) => api.patch(`/users/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });
}

export interface RoleWithPermissions {
  id: string;
  organization_id: string | null;
  name: string;
  is_system_role: boolean;
  created_at: string;
  permissions: string[];
}

export function useRoles() {
  return useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<RoleWithPermissions[]>('/roles'),
  });
}

export type { RoleSummary };
