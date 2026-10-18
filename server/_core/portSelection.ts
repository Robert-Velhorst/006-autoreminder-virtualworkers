import type { Server } from "node:http";

export async function selectServerPort(
  preferredPort: number,
  isProduction: boolean,
  findAvailablePort: (startPort: number) => Promise<number>
): Promise<number> {
  return isProduction ? preferredPort : findAvailablePort(preferredPort);
}

export function listenOnPort(
  server: Server,
  port: number,
  host: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };

    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(port, host);
  });
}
