const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const parser = require("@apidevtools/swagger-parser");
const spec = require("../swagger");
const root = path.join(__dirname, "..");
const verbs = ["get", "post", "put", "patch", "delete", "head", "options"];

test("the generated Swagger document passes OpenAPI 3 validation", async () => {
  await parser.validate(JSON.parse(JSON.stringify(spec)));
});

test("Swagger router annotations resolve independently of the working directory", () => {
  const script = `process.stdout.write(JSON.stringify(Object.keys(require(${JSON.stringify(path.join(root, "swagger.js"))}).paths).sort()))`;
  const actual = JSON.parse(execFileSync(process.execPath, ["-e", script], {
    cwd: path.dirname(root), encoding: "utf8",
  }));
  assert.deepEqual(actual, Object.keys(spec.paths).sort());
});

test("every mounted literal router endpoint has a Swagger operation", () => {
  const mounts = {
    products: ["products"], categories: ["categories"], orders: ["orders"],
    users: ["users"], auth: ["users/auth"], stripe: ["stripe"], telebirr: ["telebirr"],
    cloudinary: ["cloudinary", ""], database: ["database"], notifications: ["notifications", "users"],
    settings: ["settings"], stores: ["stores"], storeOwner: ["stores"], drivers: ["drivers"],
    "service-requests": ["service-requests"], rides: ["rides"], "exchange-rate": ["exchange-rate"],
    "store-inventory": ["stores"], "multi-delivery": ["stores"],
  };
  const missing = [];
  let checked = 0;
  for (const [file, prefixes] of Object.entries(mounts)) {
    const source = fs.readFileSync(path.join(root, "routers", `${file}.js`), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/g)) {
      for (const prefix of prefixes) {
        const endpoint = `/api/v1/${prefix}${match[3] === "/" ? "" : match[3]}`;
        const base = file === "cloudinary" && prefix === "" ? match[3] : endpoint;
        const expanded = /\(([^)]+)\)/.exec(base);
        const routes = expanded ? expanded[1].split("|").map((value) =>
          base.replace(/:action\([^)]+\)/, value)) : [base];
        for (const route of routes) {
          const template = route.replace(/:([\w]+)/g, "{$1}");
          const covered = Object.entries(spec.paths).some(([documented, item]) => {
            if (!item[match[1]]) return false;
            if (documented === template) return true;
            const pattern = "^" + documented.replace(/\{[^}]+\}/g, "([^/]+)") + "$";
            const values = new RegExp(pattern).exec(template);
            if (!values) return false;
            const names = [...documented.matchAll(/\{([^}]+)\}/g)].map((entry) => entry[1]);
            const parameters = [...(item.parameters || []), ...(item[match[1]].parameters || [])];
            return names.every((name, index) => {
              if (values[index + 1] === `{${name}}`) return true;
              const parameter = parameters.find((entry) => entry.in === "path" && entry.name === name);
              return parameter?.schema?.enum?.includes(values[index + 1]);
            });
          });
          if (!covered) missing.push(`${match[1].toUpperCase()} ${template} (${file})`);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 200, `Expected all mounted routers, checked only ${checked}`);
  assert.deepEqual(missing, [], `Missing Swagger operations:\n${missing.join("\n")}`);
});

test("every operation has responses and all template parameters are required", () => {
  for (const [endpoint, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!verbs.includes(method)) continue;
      assert.ok(Object.keys(operation.responses || {}).length, `${method} ${endpoint}: no responses`);
      const parameters = [...(item.parameters || []), ...(operation.parameters || [])];
      for (const match of endpoint.matchAll(/\{([^}]+)\}/g)) {
        assert.ok(parameters.some((parameter) => parameter.in === "path" &&
          parameter.name === match[1] && parameter.required === true),
        `${method} ${endpoint}: missing required ${match[1]}`);
      }
    }
  }
});

test("authentication documents public challenges separately from protected management", () => {
  const base = "/api/v1/users/auth";
  for (const endpoint of ["/social/start", "/social/callback/{provider}", "/social/callback/apple",
    "/social/exchange", "/2fa/verify", "/2fa/resend"]) {
    const method = endpoint === "/social/start" || endpoint === "/social/callback/{provider}" ? "get" : "post";
    assert.deepEqual(spec.paths[base + endpoint][method].security, []);
  }
  for (const endpoint of ["/security", "/2fa/setup", "/2fa/enable", "/2fa/send-code", "/2fa/disable", "/2fa/recovery"]) {
    const method = endpoint === "/security" ? "get" : "post";
    assert.notDeepEqual(spec.paths[base + endpoint][method].security, []);
  }
  const form = spec.paths[`${base}/social/callback/apple`].post.requestBody.content;
  assert.ok(form["application/x-www-form-urlencoded"]);
  for (const login of ["login", "driver-login", "store-owner-login"]) {
    const schema = spec.paths[`/api/v1/users/${login}`].post.responses[200].content["application/json"].schema;
    assert.ok(schema.oneOf.some((entry) => entry.$ref.endsWith("/TwoFactorChallenge")));
    assert.ok(schema.oneOf.some((entry) => entry.$ref.endsWith("/LoginResponse")));
  }
  assert.equal(spec.components.schemas.TwoFactorChallenge.properties.token, undefined);
  assert.ok(spec.components.schemas.TwoFactorChallenge.properties.deliveryError);
  assert.equal(spec.components.schemas.BackupCodes.minItems, 10);
});
