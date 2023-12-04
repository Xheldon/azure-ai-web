import { NextRequest, NextResponse } from "next/server";
import {
  createParser,
  ParsedEvent,
  ReconnectInterval,
} from "eventsource-parser";
import postgres from "postgres";
import { getServerSideConfig } from "../config/server";
import { DEFAULT_MODELS, OPENAI_BASE_URL } from "../constant";
import { collectModelTable } from "../utils/model";
import { makeAzurePath } from "../azure";

const serverConfig = getServerSideConfig();

export const sql = postgres({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
});

export async function requestOpenai(req: NextRequest) {
  const controller = new AbortController();

  const authValue = req.headers.get("Authorization") ?? "";
  const authHeaderName = serverConfig.isAzure ? "api-key" : "Authorization";

  let path = `${req.nextUrl.pathname}${req.nextUrl.search}`.replaceAll(
    "/api/openai/",
    "",
  );

  let baseUrl =
    serverConfig.azureUrl || serverConfig.baseUrl || OPENAI_BASE_URL;

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  console.log("[Proxy] ", path);
  console.log("[Base Url]", baseUrl);
  // this fix [Org ID] undefined in server side if not using custom point
  if (serverConfig.openaiOrgId !== undefined) {
    console.log("[Org ID]", serverConfig.openaiOrgId);
  }

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  if (serverConfig.isAzure) {
    if (!serverConfig.azureApiVersion) {
      return NextResponse.json({
        error: true,
        message: `missing AZURE_API_VERSION in server env vars`,
      });
    }
    path = makeAzurePath(path, serverConfig.azureApiVersion);
  }

  const fetchUrl = `${baseUrl}/${path}`;
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
      const modelTable = collectModelTable(
        DEFAULT_MODELS,
        serverConfig.customModels,
      );
      const clonedBody = await req.text();
      fetchOptions.body = clonedBody;

      const jsonBody = JSON.parse(clonedBody) as { model?: string };

      // not undefined and is false
      if (modelTable[jsonBody?.model ?? ""].available === false) {
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

    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export const readResponseToLog = (result: any) => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const readableStream = new ReadableStream({
    async start(controller) {
      function onParse(event: ParsedEvent | ReconnectInterval) {
        if (event.type === "event") {
          const data = event.data as any;
          if (data === "[DONE]") {
            // Signal the end of the stream
            controller.enqueue(encoder.encode("[DONE]"));
          }
          // feed the data to the TransformStream for further processing
          controller.enqueue(encoder.encode(data));
        }
      }

      if (result.status !== 200) {
        const data = {
          status: result.status,
          statusText: result.statusText,
          body: await result.text(),
        };
        console.log(
          `Error: recieved non-200 status code, ${JSON.stringify(data)}`,
        );
        controller.close();
        return;
      }

      const parser = createParser(onParse);
      // https://web.dev/streams/#asynchronous-iteration
      for await (const chunk of result.body as any) {
        parser.feed(decoder.decode(chunk));
      }
    },
  });
  let counter = 0;
  let str = "";
  return new Promise(async (resolve) => {
    const transformStream = new TransformStream({
      async transform(chunk, controller) {
        const content = decoder.decode(chunk);
        if (content === "[DONE]") {
          console.log("[Chat result]:", str);
          controller.terminate(); // Terminate the TransformStream
          resolve(str);
          return;
        }
        try {
          let json = JSON.parse(content);
          // Note: 坑：Azure gpt-4 第一个 json 啥也没有
          if (!json.id || !json.model) {
            return;
          }
          // Note: openai 接口结束会有个 [DONE]，但是 Azure 的没有，此处兼容
          if (json.choices[0]?.finish_reason) {
            console.log("[Chat result]:", str);
            controller.terminate();
            resolve(str);
            return;
          }

          if (json.choices[0]?.delta) {
            // Note: 因为这个原因: https://vercel.com/docs/concepts/functions/edge-functions/streaming#caveats
            //  我只返回 content，不返回 json 了，因为不好解析:
            json = json.choices[0]?.delta?.content || "";
          }
          if (!json.id)
            if (counter < 2 && (json.match(/\n/) || []).length) {
              // 学习: https://github.com/Nutlope/twitterbio/blob/main/utils/OpenAIStream.ts
              // 前缀字符: (i.e., "\n\n"), do nothing
              return;
            }
          // console.log('json:', json);
          str += json;
          controller.enqueue(encoder.encode(`${json}`));
          counter++;
        } catch (e: any) {
          console.log(`[Chat stream error]:`, e);
          resolve(`[[OPENAI_ERROR]]${e.toString()}`);
        }
      },
    });
    const reader = readableStream.pipeThrough(transformStream).getReader();
    let res = "";
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      // 将数据写入响应对象
      res += value;
    }

    // 结束响应
    resolve(res);
  });
};
