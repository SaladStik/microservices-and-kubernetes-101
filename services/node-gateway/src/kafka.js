// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
// Kafka wiring. One producer for job requests, one consumer for Debezium CDC.
import { Kafka, logLevel } from "kafkajs";
import { config } from "./config.js";

const kafka = new Kafka({
  clientId: config.kafka.clientId,
  brokers: config.kafka.brokers,
  logLevel: logLevel.NOTHING,
  retry: { initialRetryTime: 1000, retries: 20 },
});

const producer = kafka.producer();

export async function connectProducer() {
  await producer.connect();
  console.log(`[gateway] producer connected to ${config.kafka.brokers.join(",")}`);
}

// publish the job event. the worker picks it up on its own
export async function publishJob(job) {
  await producer.send({
    topic: config.kafka.jobRequestsTopic,
    messages: [{ key: job.jobId, value: JSON.stringify(job) }],
  });
}

// subscribe to the CDC topic and call onChange(afterRow, op) per row change
export async function consumeCdc(onChange) {
  const consumer = kafka.consumer({ groupId: config.kafka.cdcGroupId });
  await consumer.connect();
  await consumer.subscribe({ topic: config.kafka.cdcTopic, fromBeginning: false });
  console.log(`[gateway] consuming CDC topic '${config.kafka.cdcTopic}'`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return; // tombstones have a null value
      const envelope = JSON.parse(message.value.toString());
      if (envelope && envelope.after) {
        onChange(envelope.after, envelope.op);
      }
    },
  });
}
