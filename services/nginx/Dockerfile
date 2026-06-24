# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
FROM nginx:1.27-alpine

# replace default server with our allowlist, auth_request, TLS config
RUN rm /etc/nginx/conf.d/default.conf
COPY conf.d/default.conf /etc/nginx/conf.d/default.conf

# certs are mounted at runtime, just make the mount point
RUN mkdir -p /etc/nginx/certs

# site favicon, served by the edge
COPY static /etc/nginx/static

EXPOSE 80 443
