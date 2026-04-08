import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyReply } from "fastify";

const webRoot = resolve(process.cwd(), "web", "build-artifact");

const contentTypeByExtension: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

const guessContentType = (filePath: string): string => {
  const extension = filePath.slice(filePath.lastIndexOf("."));
  return contentTypeByExtension[extension] ?? "application/octet-stream";
};

const fallbackHtml = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>PedimOS</title>
  </head>
  <body style="font-family: Inter, system-ui, sans-serif; padding: 24px">
    <h1>PedimOS</h1>
    <p>UI artifact no disponible en este entorno. Compila web/build-artifact para habilitar el frontend cliente.</p>
  </body>
</html>`;

export const sendWebIndex = async (reply: FastifyReply): Promise<FastifyReply> => {
  try {
    const file = await readFile(resolve(webRoot, "index.html"));
    return reply.type("text/html; charset=utf-8").status(200).send(file);
  } catch {
    return reply.type("text/html; charset=utf-8").status(200).send(fallbackHtml);
  }
};

export const sendWebAsset = async (reply: FastifyReply, assetPath: string): Promise<FastifyReply> => {
  const normalized = assetPath.replace(/^\/+/, "");
  const fullPath = resolve(webRoot, normalized);
  if (!fullPath.startsWith(webRoot)) {
    return reply.status(403).send({ success: false, error: "Asset path forbidden" });
  }

  try {
    const file = await readFile(fullPath);
    return reply.type(guessContentType(fullPath)).status(200).send(file);
  } catch {
    return reply.status(404).send({ success: false, error: "Asset not found" });
  }
};
