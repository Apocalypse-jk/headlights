import { createServer } from "node:http";

const host = process.env.BIND_HOST || "0.0.0.0";
const port = Number.parseInt(process.env.BIND_PORT || "8080", 10);
const total = Number.parseInt(process.env.MOCK_BLAZE_TOTAL || "15050", 10);
const diagnosisTotal = Number.parseInt(process.env.MOCK_BLAZE_DIAGNOSIS_TOTAL || "1000", 10);
const delayMs = Number.parseInt(process.env.MOCK_BLAZE_DELAY_MS || "0", 10);
const logRequests = ["1", "true", "yes"].includes((process.env.MOCK_BLAZE_LOG_REQUESTS || "true").toLowerCase());

const capabilityStatement = {
  resourceType: "CapabilityStatement",
  status: "active",
  date: new Date(0).toISOString(),
  kind: "instance",
  fhirVersion: "4.0.1",
  format: ["json"],
  rest: [
    {
      mode: "server",
      resource: [
        { type: "Patient", interaction: [{ code: "search-type" }, { code: "read" }] },
        { type: "Specimen", interaction: [{ code: "search-type" }, { code: "read" }] },
        { type: "Condition", interaction: [{ code: "search-type" }, { code: "read" }] },
        { type: "Observation", interaction: [{ code: "search-type" }, { code: "read" }] },
      ],
    },
  ],
};

const server = createServer(async (request, response) => {
  const started = Date.now();
  const url = new URL(request.url || "/", `http://${request.headers.host || "mock-blaze"}`);

  try {
    await drainRequest(request);
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    if (request.method === "OPTIONS") {
      sendJson(response, 204, undefined);
      return;
    }

    if (url.pathname === "/health" || url.pathname === "/fhir/metadata") {
      sendJson(response, 200, capabilityStatement);
      return;
    }

    if (url.pathname === "/fhir" && request.method === "POST") {
      sendJson(response, 200, {
        resourceType: "Bundle",
        type: "transaction-response",
        entry: [],
      });
      return;
    }

    if (url.pathname.startsWith("/fhir/") && url.pathname.includes("$evaluate-measure")) {
      sendJson(response, 200, measureReport(url));
      return;
    }

    if (url.pathname.startsWith("/fhir/")) {
      sendJson(response, 200, searchBundle(url));
      return;
    }

    sendJson(response, 404, {
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "error",
          code: "not-found",
          diagnostics: `Mock Blaze has no route for ${request.method} ${url.pathname}`,
        },
      ],
    });
  } finally {
    if (logRequests) {
      console.log(`[mock-blaze] ${request.method} ${url.pathname}${url.search} ${Date.now() - started}ms`);
    }
  }
});

server.listen(port, host, () => {
  console.log(`[mock-blaze] listening on http://${host}:${port}`);
  console.log(`[mock-blaze] fixed Bundle.total=${total}, diagnosis.total=${diagnosisTotal}, delay=${delayMs}ms`);
});

function searchBundle(url) {
  return {
    resourceType: "Bundle",
    type: "searchset",
    total,
    link: [
      {
        relation: "self",
        url: url.toString(),
      },
    ],
    entry: [],
  };
}

function measureReport(url) {
  return {
    resourceType: "MeasureReport",
    extension: [],
    status: "complete",
    type: "summary",
    measure: url.searchParams.get("measure") || "urn:uuid:mock-measure",
    date: new Date().toISOString(),
    period: {
      start: "1970-01-01T00:00:00.000Z",
      end: "1970-01-01T00:00:00.000Z",
    },
    group: [
      measureGroup("patient", total),
      measureGroup("diagnosis", diagnosisTotal),
    ],
  };
}

function measureGroup(code, count) {
  return {
    id: code,
    extension: [],
    code: {
      text: code,
      coding: [
        {
          system: "http://samply.de/fhir/focus/CodeSystem/stratifier",
          code,
          display: code,
        },
      ],
    },
    population: [
      {
        extension: [],
        code: {
          text: "initial-population",
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/measure-population",
              code: "initial-population",
              display: "initial-population",
            },
          ],
        },
        count,
      },
    ],
    stratifier: [],
  };
}

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  response.setHeader("access-control-allow-headers", "*");

  if (value === undefined) {
    response.end();
    return;
  }

  const body = JSON.stringify(value);
  response.setHeader("content-type", "application/fhir+json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

async function drainRequest(request) {
  for await (const _chunk of request) {
    // The mock does not need request bodies, but draining keeps clients happy.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
