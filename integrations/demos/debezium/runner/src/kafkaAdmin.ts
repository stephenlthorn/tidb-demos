import { KafkaJS } from '@confluentinc/kafka-javascript';
import { sumHighWatermarkOffsets } from './topicOffsets';

export type KafkaAdmin = {
  readonly connect: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly fetchHighWatermarkSum: (topic: string) => Promise<number>;
};

export const createKafkaAdmin = (options: { readonly brokers: readonly string[] }): KafkaAdmin => {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: [...options.brokers], logLevel: KafkaJS.logLevel.NOTHING },
  });
  const admin = kafka.admin();
  const fetchHighWatermarkSum = async (topic: string): Promise<number> =>
    sumHighWatermarkOffsets(await admin.fetchTopicOffsets(topic));
  return {
    connect: () => admin.connect(),
    disconnect: () => admin.disconnect(),
    fetchHighWatermarkSum,
  };
};
