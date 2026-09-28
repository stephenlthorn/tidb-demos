import { KafkaJS } from '@confluentinc/kafka-javascript';

export type SharedConsumer = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly drain: () => readonly string[];
};

export const createSharedConsumer = (options: {
  readonly brokers: readonly string[];
  readonly groupId: string;
  readonly topics: readonly string[];
}): SharedConsumer => {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: [...options.brokers], logLevel: KafkaJS.logLevel.NOTHING },
    'topic.metadata.refresh.interval.ms': 5000,
  });
  const consumer = kafka.consumer({ kafkaJS: { groupId: options.groupId } });
  let buffer: string[] = [];

  const start = async (): Promise<void> => {
    await consumer.connect();
    await consumer.subscribe({ topics: [...options.topics] });
    await consumer.run({
      eachMessage: async ({ message }) => {
        if (message.value !== null) buffer.push(message.value.toString('utf-8'));
      },
    });
  };

  const stop = async (): Promise<void> => {
    await consumer.disconnect();
  };

  const drain = (): readonly string[] => {
    const drained = buffer;
    buffer = [];
    return drained;
  };

  return { start, stop, drain };
};
