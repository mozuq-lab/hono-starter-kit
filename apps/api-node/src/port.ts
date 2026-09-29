const hostError = () => new Error("HOST must be 127.0.0.1 or 0.0.0.0");

export const parseHost = (rawHost: string | undefined) => {
  const value = rawHost ?? "127.0.0.1";

  if (value !== "127.0.0.1" && value !== "0.0.0.0") throw hostError();

  return value;
};

const portError = () => new Error("PORT must be 1-65535");

export const parsePort = (rawPort: string | undefined) => {
  const value = rawPort ?? "3000";

  if (!/^[0-9]+$/.test(value)) throw portError();

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) throw portError();

  return port;
};
