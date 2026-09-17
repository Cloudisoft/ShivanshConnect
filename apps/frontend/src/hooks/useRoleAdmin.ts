import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Permission } from '@shivanshconnect/shared';
import { api } from '../lib/apiClient';
import type { RoleWithPermissions } from './useUsers';

export function usePermissionCatalog() {
  return useQuery({
    queryKey: ['permission-catalog'],
    queryFn: () => api.get<Permission[]>('/permissions'),
  });
}

export function useCreateRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; permission_keys: string[] }) =>
      api.post<RoleWithPermissions>('/roles', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['roles'] }),
  });
}

export function useUpdateRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; name?: string; permission_keys?: string[] }) =>
      api.patch<RoleWithPermissions>(`/roles/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['roles'] }),
  });
}

export function useDeleteRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/roles/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['roles'] }),
  });
}
