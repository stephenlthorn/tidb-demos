import { z } from 'zod';

const ConnectorStatusResponseSchema = z.object({
  connector: z.object({ state: z.string() }),
  tasks: z.array(z.object({ id: z.number(), state: z.string() })),
});

export type ConnectorStatusResponse = z.infer<typeof ConnectorStatusResponseSchema>;

export type ConnectApi = {
  readonly getStatus: (name: string) => Promise<ConnectorStatusResponse>;
};

export const createConnectApi = (options: { readonly baseUrl: string }): ConnectApi => {
  const getStatus = async (name: string): Promise<ConnectorStatusResponse> => {
    const response = await fetch(`${options.baseUrl}/connectors/${name}/status`);
    if (!response.ok) {
      throw new Error(`connect status request for ${name} failed with ${response.status}`);
    }
    const body: unknown = await response.json();
    return ConnectorStatusResponseSchema.parse(body);
  };
  return { getStatus };
};
