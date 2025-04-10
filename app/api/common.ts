import { NextRequest, NextResponse } from "next/server";
import { getServerSideConfig } from "../config/server";
import { OPENAI_BASE_URL, ServiceProvider } from "../constant";
import { cloudflareAIGatewayUrl } from "../utils/cloudflare";
import { getModelProvider, isModelNotavailableInServer } from "../utils/model";
import { AzureCliCredential } from "@azure/identity";

const serverConfig = getServerSideConfig();

export async function requestOpenai(req: NextRequest) {
  const controller = new AbortController();

  const isAzure = serverConfig.azureUrl !== "";
  // Determine if Azure CLI Auth should be used (only applicable for Azure)
  const azureUseCLIAuth = isAzure && serverConfig.azureUseCLIAuth; // Read the flag

  var authValue,
    authHeaderName = "";
  // if Azure CLI Auth is not used, then use the API Key
  if (isAzure && !azureUseCLIAuth) {
    authValue =
      req.headers
        .get("Authorization")
        ?.trim()
        .replaceAll("Bearer ", "")
        .trim() ?? "";

    authHeaderName = "api-key";
    console.log("[Azure Auth] Using API Key");
  } else if (!isAzure) {
    authValue = req.headers.get("Authorization") ?? "";
    authHeaderName = "Authorization";
  }
  let path = `${req.nextUrl.pathname}`.replaceAll("/api/openai/", "");

  let baseUrl =
    (isAzure ? serverConfig.azureUrl : serverConfig.baseUrl) || OPENAI_BASE_URL;

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  console.log("[Proxy] ", path);
  console.log("[Base Url]", baseUrl);

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  if (isAzure) {
    const azureApiVersion =
      req?.nextUrl?.searchParams?.get("api-version") ||
      serverConfig.azureApiVersion;
    baseUrl = baseUrl.split("/deployments").shift() as string;
    path = `${req.nextUrl.pathname.replaceAll(
      "/api/azure/",
      "",
    )}?api-version=${azureApiVersion}`;

    // if Azure CLI Auth is used, then use the Azure CLI Credential to get a token and add it to the Authorization header
    if (azureUseCLIAuth) {
      console.log("[Azure CLI Auth] Using Azure CLI Auth");
      const credential = new AzureCliCredential();
      console.log("[Azure CLI Auth] Attempting to get token...");
      const tokenResponse = await credential.getToken(
        "https://cognitiveservices.azure.com/.default",
      );
      if (!tokenResponse?.token) {
        throw new Error("Failed to get Azure AD token.");
      }
      console.log(
        "[Azure CLI Auth] Token acquired, expires on:",
        new Date(tokenResponse.expiresOnTimestamp),
      );
      authValue = `Bearer ${tokenResponse.token}`; // Set value for Authorization header
      authHeaderName = "Authorization"; // Set header name
    }

    // Forward compatibility:
    // if display_name(deployment_name) not set, and '{deploy-id}' in AZURE_URL
    // then using default '{deploy-id}'
    if (serverConfig.customModels && serverConfig.azureUrl) {
      const modelName = path.split("/")[1];
      let realDeployName = "";
      serverConfig.customModels
        .split(",")
        .filter((v) => !!v && !v.startsWith("-") && v.includes(modelName))
        .forEach((m) => {
          const [fullName, displayName] = m.split("=");
          const [_, providerName] = getModelProvider(fullName);
          if (providerName === "azure" && !displayName) {
            const [_, deployId] = (serverConfig?.azureUrl ?? "").split(
              "deployments/",
            );
            if (deployId) {
              realDeployName = deployId;
            }
          }
        });
      if (realDeployName) {
        console.log("[Replace with DeployId", realDeployName);
        path = path.replaceAll(modelName, realDeployName);
      }
    }
  }

  // CAB - This is janky, but force the URL if we have all of the pieces in the config.
  // this only happens if the config file has AZURE_URL, AZURE_DEPLOYMENT, and AZURE_API_VERSION
  // all set in the .env.local file.
  // *** This will force the web ui settings regarding the model and endpoint to be overridden ***
  var fetchUrl = "";
  if (
    serverConfig.isAzure &&
    serverConfig.azureDeployment &&
    serverConfig.azureUrl &&
    serverConfig.azureApiVersion
  ) {
    fetchUrl = `${serverConfig.azureUrl}/openai/deployments/${serverConfig.azureDeployment}/chat/completions?api-version=${serverConfig.azureApiVersion}`;
    console.log(
      "[Azure URL] Using Azure endpoint settings from environment config (.env.local).  Forcing URL to:",
      fetchUrl,
    );
    console.log(
      "[Azure URL] Any endpoint or model selection settings in the web ui will be ignored.",
    );
  } else {
    fetchUrl = cloudflareAIGatewayUrl(`${baseUrl}/${path}`);
  }

  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      [authHeaderName]: authValue,
      ...(serverConfig.openaiOrgId && {
        "OpenAI-Organization": serverConfig.openaiOrgId,
      }),
    },
    method: req.method,
    body: req.body,
    // to fix #2485: https://stackoverflow.com/questions/55920957/cloudflare-worker-typeerror-one-time-use-body
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  // #1815 try to refuse gpt4 request
  if (serverConfig.customModels && req.body) {
    try {
      const clonedBody = await req.text();
      fetchOptions.body = clonedBody;

      const jsonBody = JSON.parse(clonedBody) as { model?: string };

      // not undefined and is false
      if (
        isModelNotavailableInServer(
          serverConfig.customModels,
          jsonBody?.model as string,
          [
            ServiceProvider.OpenAI,
            ServiceProvider.Azure,
            jsonBody?.model as string, // support provider-unspecified model
          ],
        )
      ) {
        return NextResponse.json(
          {
            error: true,
            message: `you are not allowed to use ${jsonBody?.model} model`,
          },
          {
            status: 403,
          },
        );
      }
    } catch (e) {
      console.error("[OpenAI] gpt4 filter", e);
    }
  }

  try {
    const res = await fetch(fetchUrl, fetchOptions);

    // Extract the OpenAI-Organization header from the response
    const openaiOrganizationHeader = res.headers.get("OpenAI-Organization");

    // Check if serverConfig.openaiOrgId is defined and not an empty string
    if (serverConfig.openaiOrgId && serverConfig.openaiOrgId.trim() !== "") {
      // If openaiOrganizationHeader is present, log it; otherwise, log that the header is not present
      console.log("[Org ID]", openaiOrganizationHeader);
    } else {
      console.log("[Org ID] is not set up.");
    }

    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    // Conditionally delete the OpenAI-Organization header from the response if [Org ID] is undefined or empty (not setup in ENV)
    // Also, this is to prevent the header from being sent to the client
    if (!serverConfig.openaiOrgId || serverConfig.openaiOrgId.trim() === "") {
      newHeaders.delete("OpenAI-Organization");
    }

    // The latest version of the OpenAI API forced the content-encoding to be "br" in json response
    // So if the streaming is disabled, we need to remove the content-encoding header
    // Because Vercel uses gzip to compress the response, if we don't remove the content-encoding header
    // The browser will try to decode the response with brotli and fail
    newHeaders.delete("content-encoding");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
