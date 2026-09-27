import { KafkaJS } from '@confluentinc/kafka-javascript';

export type ConsumeHandler = (payload: KafkaJS.EachMessagePayload) => Promise<void>;

export type CreateConsumerOptions = {
  readonly groupId: string;
  readonly topic: string;
  readonly onMessage: ConsumeHandler;
};

export type TopicLagOptions = {
  readonly groupId: string;
  readonly topic: string;
};

export type KafkaClients = {
  readonly producer: KafkaJS.Producer;
  readonly connect: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly createConsumer: (options: CreateConsumerOptions) => Promise<KafkaJS.Consumer>;
  readonly fetchGroupLag: (options: TopicLagOptions) => Promise<number>;
};

export const createKafkaClients = (options: { readonly brokers: readonly string[] }): KafkaClients => {
  const kafka = new KafkaJS.Kafka({
    'bootstrap.servers': options.brokers.join(','),
    kafkaJS: { brokers: [...options.brokers], logLevel: KafkaJS.logLevel.NOTHING },
  });
  const producer = kafka.producer();
  const admin = kafka.admin();

  const connect = async (): Promise<void> => {
    await producer.connect();
    await admin.connect();
  };

  const disconnect = async (): Promise<void> => {
    await producer.disconnect();
    await admin.disconnect();
  };

  const createConsumer = async (consumerOptions: CreateConsumerOptions): Promise<KafkaJS.Consumer> => {
    const consumer = kafka.consumer({
      'group.id': consumerOptions.groupId,
      'auto.offset.reset': 'earliest',
    });
    await consumer.connect();
    await consumer.subscribe({ topics: [consumerOptions.topic] });
    void consumer.run({ eachMessage: consumerOptions.onMessage });
    return consumer;
  };

  const fetchGroupLag = async (lagOptions: TopicLagOptions): Promise<number> => {
    const watermarks = await admin.fetchTopicOffsets(lagOptions.topic);
    const committed = await admin.fetchOffsets({ groupId: lagOptions.groupId, topics: [lagOptions.topic] });
    const highTotal = watermarks.reduce((sum, partition) => sum + Number(partition.high), 0);
    const committedTotal = committed
      .flatMap((topicOffsets) => topicOffsets.partitions)
      .reduce((sum, partition) => sum + Math.max(0, Number(partition.offset)), 0);
    return Math.max(0, highTotal - committedTotal);
  };

  return { producer, connect, disconnect, createConsumer, fetchGroupLag };
};
