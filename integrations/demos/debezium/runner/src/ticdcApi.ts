export type TicdcApi = {
  readonly changefeedExists: (id: string) => Promise<boolean>;
  readonly createDebeziumChangefeed: (options: { readonly id: string; readonly sinkUri: string }) => Promise<void>;
};

export const createTicdcApi = (options: { readonly baseUrl: string }): TicdcApi => {
  const changefeedExists = async (id: string): Promise<boolean> => {
    const response = await fetch(`${options.baseUrl}/api/v2/changefeeds/${id}`);
    return response.ok;
  };
  const createDebeziumChangefeed = async (createOptions: { readonly id: string; readonly sinkUri: string }): Promise<void> => {
    const response = await fetch(`${options.baseUrl}/api/v2/changefeeds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changefeed_id: createOptions.id, sink_uri: createOptions.sinkUri }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`create changefeed ${createOptions.id} failed with ${response.status}: ${body}`);
    }
  };
  return { changefeedExists, createDebeziumChangefeed };
};
