import { KafkaJS } from '@confluentinc/kafka-javascript';

export interface OutboundMessage {
  topic: string;
  key: string;
  value: string;
  /** Payload format for the x-source-format header, e.g. "aurex.v1". */
  format: string;
}

export interface ProducerOptions {
  brokers: string;
  clientId: string;
  lingerMs: number;
}

/**
 * Durable producer (brief §5.3): idempotent, acks=all, zstd, small linger for batching.
 * Adds the x-sent-at (wall-clock ms) and x-source-format headers to every message.
 */
export class TelemetryProducer {
  private readonly producer: KafkaJS.Producer;

  constructor(opts: ProducerOptions) {
    const kafka = new KafkaJS.Kafka({
      kafkaJS: { brokers: opts.brokers.split(','), clientId: opts.clientId, logLevel: KafkaJS.logLevel.WARN },
    });
    this.producer = kafka.producer({
      'linger.ms': opts.lingerMs,
      'batch.size': 262_144,
      kafkaJS: {
        idempotent: true,
        acks: -1,
        compression: KafkaJS.CompressionTypes.ZSTD,
      },
    });
  }

  connect(): Promise<void> {
    return this.producer.connect();
  }

  /** Send a batch grouped by topic; resolves once every message is acknowledged by the broker. */
  async send(messages: readonly OutboundMessage[], wallNow: () => number = Date.now): Promise<void> {
    if (messages.length === 0) return;
    const sentAt = String(wallNow());
    const byTopic = new Map<string, KafkaJS.Message[]>();
    for (const m of messages) {
      let list = byTopic.get(m.topic);
      if (!list) byTopic.set(m.topic, (list = []));
      list.push({ key: m.key, value: m.value, headers: { 'x-sent-at': sentAt, 'x-source-format': m.format } });
    }
    await this.producer.sendBatch({
      topicMessages: [...byTopic].map(([topic, msgs]) => ({ topic, messages: msgs })),
    });
  }

  async disconnect(): Promise<void> {
    await this.producer.flush({ timeout: 10_000 });
    await this.producer.disconnect();
  }
}

/** Consume a topic with a consumer group (at-least-once: offsets commit after the handler resolves). */
export async function consumeTopic(
  opts: Omit<ProducerOptions, 'lingerMs'> & { groupId: string; fromBeginning: boolean },
  topic: string,
  handler: (key: string | null, value: string | null) => Promise<void>,
): Promise<{ stop: () => Promise<void> }> {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: opts.brokers.split(','), clientId: opts.clientId, logLevel: KafkaJS.logLevel.WARN },
  });
  const consumer = kafka.consumer({ kafkaJS: { groupId: opts.groupId, fromBeginning: opts.fromBeginning } });
  await consumer.connect();
  await consumer.subscribe({ topics: [topic] });
  await consumer.run({
    eachMessage: async ({ message }) => {
      await handler(message.key?.toString() ?? null, message.value?.toString() ?? null);
    },
  });
  return { stop: () => consumer.disconnect() };
}
