# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
# Strimzi Connect image with the Debezium Postgres connector plugin baked in.

FROM quay.io/strimzi/kafka:0.43.0-kafka-3.8.0

USER root:root
ARG DEBEZIUM_VERSION=2.7.4.Final

RUN mkdir -p /opt/kafka/plugins/debezium \
 && curl -fsSL "https://repo1.maven.org/maven2/io/debezium/debezium-connector-postgres/${DEBEZIUM_VERSION}/debezium-connector-postgres-${DEBEZIUM_VERSION}-plugin.tar.gz" \
    | tar -xz -C /opt/kafka/plugins/debezium

USER 1001
