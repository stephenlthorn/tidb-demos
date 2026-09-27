import { z } from 'zod';

export type OktaPollerOptions = {
  readonly orgUrl: string;
  readonly apiToken: string;
};

const OktaLogTargetSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
});

const OktaLogEventSchema = z.object({
  uuid: z.string().min(1),
  published: z.string().min(1),
  eventType: z.string().min(1),
  target: z.array(OktaLogTargetSchema).default([]),
});

export type OktaLogEvent = z.infer<typeof OktaLogEventSchema>;

const OktaLogEventsSchema = z.array(OktaLogEventSchema);

const OktaGroupUserSchema = z.object({ id: z.string().min(1) });
const OktaGroupUsersSchema = z.array(OktaGroupUserSchema);

const oktaFetch = async (options: OktaPollerOptions, path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${options.orgUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `SSWS ${options.apiToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

const parseBody = <T>(schema: z.ZodType<T>, body: unknown, context: string): T => {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error(`${context} response failed validation: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  return result.data;
};

export const fetchGroupEventsSince = async (
  options: OktaPollerOptions,
  sinceIso: string,
): Promise<readonly OktaLogEvent[]> => {
  const filter = encodeURIComponent(
    'eventType eq "group.user_membership.add" or eventType eq "group.user_membership.remove" or eventType eq "user.lifecycle.deactivate"',
  );
  const response = await oktaFetch(
    options,
    `/api/v1/logs?since=${encodeURIComponent(sinceIso)}&filter=${filter}&sortOrder=ASCENDING`,
  );
  if (!response.ok) {
    throw new Error(`okta system log request failed: ${response.status}`);
  }
  return parseBody(OktaLogEventsSchema, await response.json(), 'okta system log');
};

export const fetchGroupMemberIds = async (
  options: OktaPollerOptions,
  groupId: string,
): Promise<readonly string[]> => {
  const response = await oktaFetch(options, `/api/v1/groups/${groupId}/users`);
  if (!response.ok) {
    throw new Error(`okta group members request failed: ${response.status}`);
  }
  const users = parseBody(OktaGroupUsersSchema, await response.json(), 'okta group members');
  return users.map((user) => user.id);
};

export const addUserToGroup = async (options: OktaPollerOptions, groupId: string, userId: string): Promise<void> => {
  const response = await oktaFetch(options, `/api/v1/groups/${groupId}/users/${userId}`, { method: 'PUT' });
  if (!response.ok) {
    throw new Error(`okta add-to-group failed: ${response.status}`);
  }
};

export const removeUserFromGroup = async (
  options: OktaPollerOptions,
  groupId: string,
  userId: string,
): Promise<void> => {
  const response = await oktaFetch(options, `/api/v1/groups/${groupId}/users/${userId}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(`okta remove-from-group failed: ${response.status}`);
  }
};

export const deactivateUser = async (options: OktaPollerOptions, userId: string): Promise<void> => {
  const response = await oktaFetch(options, `/api/v1/users/${userId}/lifecycle/deactivate?sendEmail=false`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`okta deactivate failed: ${response.status}`);
  }
};
