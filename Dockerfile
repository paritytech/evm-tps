FROM docker.io/library/node:lts-bullseye-slim

# The image contains a https://github.com/arturgontijo/evm-tps since it's needed to run the tests
WORKDIR /evm-tps
COPY . /evm-tps

RUN npm install -g npm@9.7.2 && \
  yarn && \
  yarn cache clean
