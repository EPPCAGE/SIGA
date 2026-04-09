FROM docker.io/library/nginx:1.27-alpine

COPY docker/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY __main__.js /usr/share/nginx/html/__main__.js
COPY sw.js /usr/share/nginx/html/sw.js
COPY public-config.js /usr/share/nginx/html/public-config.js
COPY modules /usr/share/nginx/html/modules

RUN mkdir -p /var/cache/nginx/client_temp \
             /var/cache/nginx/proxy_temp \
             /var/cache/nginx/fastcgi_temp \
             /var/cache/nginx/uwsgi_temp \
             /var/cache/nginx/scgi_temp \
    && chown -R nginx:nginx /var/cache/nginx \
    && touch /var/run/nginx.pid \
    && chown nginx:nginx /var/run/nginx.pid \
    && apk add --no-cache openssl \
    && mkdir -p /etc/nginx/certs \
    && openssl req -x509 -newkey rsa:2048 \
         -keyout /etc/nginx/certs/server.key \
         -out    /etc/nginx/certs/server.crt \
         -days 1095 -nodes \
         -subj "/CN=gesproc" \
    && chown -R nginx:nginx /etc/nginx/certs \
    && chmod 600 /etc/nginx/certs/server.key

USER nginx
