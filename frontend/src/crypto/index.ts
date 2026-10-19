// Cripto do protocolo de sync v1 — módulo autocontido (só WebCrypto + hash-wasm), espelho de
// docs/test-vectors/generate.ts. Pode ser compartilhado com outros clientes TS (app, mobile).
// Testes: src/crypto/vectors.test.ts consome docs/test-vectors/*.json byte a byte.
export * from './constants'
export * from './encoding'
export * from './primitives'
export * from './kdf'
export * from './keys'
export * from './envelope'
export * from './blob'
export * from './setup'
