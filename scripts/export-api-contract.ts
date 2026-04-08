import fs from "node:fs";
import path from "node:path";
import { openApiSpec } from "../src/docs/openapi";

const docsDir = path.resolve(process.cwd(), "..", "docs");
const outputPath = path.resolve(docsDir, "jobizy-api-contract.generated.md");
const openApiJsonPath = path.resolve(docsDir, "jobizy-openapi.generated.json");

const lines: string[] = [];
lines.push("# Jobizy - Contrat API genere");
lines.push("");
lines.push("Ce document est genere a partir de la specification OpenAPI du backend `backend/`.");
lines.push("");
lines.push("## Informations generales");
lines.push("");
lines.push(`- Titre : ${openApiSpec.info.title}`);
lines.push(`- Version : ${openApiSpec.info.version}`);
lines.push(`- Description : ${openApiSpec.info.description}`);
lines.push("");
lines.push("## Serveurs");
lines.push("");

for (const server of openApiSpec.servers) {
  lines.push(`- ${server.description} : \`${server.url}\``);
}

lines.push("");
lines.push("## Endpoints");
lines.push("");

for (const [route, methods] of Object.entries(openApiSpec.paths)) {
  lines.push(`### \`${route}\``);
  lines.push("");

  for (const [method, operation] of Object.entries(methods)) {
    const summary = (operation as { summary?: string }).summary ?? "";
    lines.push(`- ${method.toUpperCase()} : ${summary}`);
  }

  lines.push("");
}

fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
fs.writeFileSync(openApiJsonPath, `${JSON.stringify(openApiSpec, null, 2)}\n`, "utf8");
console.log(`API contract exported to ${outputPath}`);
console.log(`OpenAPI JSON exported to ${openApiJsonPath}`);
