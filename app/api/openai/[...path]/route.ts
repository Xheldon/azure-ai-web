import { type OpenAIListModelResponse } from "@/app/client/platforms/openai";
import { getServerSideConfig } from "@/app/config/server";
import { OpenaiPath } from "@/app/constant";
import { prettyObject } from "@/app/utils/format";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../auth";
import { requestOpenai, readResponseToLog, sql } from "../../common";

const ALLOWD_PATH = new Set(Object.values(OpenaiPath));

function getModels(remoteModelRes: OpenAIListModelResponse) {
  const config = getServerSideConfig();

  if (config.disableGPT4) {
    remoteModelRes.data = remoteModelRes.data.filter(
      (m) => !m.id.startsWith("gpt-4"),
    );
  }

  return remoteModelRes;
}

async function handle(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  console.log("[OpenAI Route] params ", params);

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const subpath = params.path.join("/");

  if (!ALLOWD_PATH.has(subpath)) {
    console.log("[OpenAI Route] forbidden path ", subpath);
    return NextResponse.json(
      {
        error: true,
        msg: "请求被禁止哦 " + subpath,
      },
      {
        status: 403,
      },
    );
  }

  const authResult = auth(req);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  try {
    const reqForLogRaw = req.clone().text();
    const response = await requestOpenai(req);
    // Note: log 不能影响主流程，因此异步执行
    reqForLogRaw
      .then((str) => {
        const reqForLog = JSON.parse(str);
        // console.log('请求内容:', reqForLog);
        // Note: access token 以使用人开头，_ 分割后面是真正的 token
        const nickName = authResult.code?.split("_")[0];
        const _createtime = new Date(Date.now());
        _createtime.setUTCHours(_createtime.getUTCHours() + 8);
        const _createtime_ = _createtime.toISOString();
        const _messages = reqForLog.messages.slice() || [];
        readResponseToLog(response.clone())
          .then((resForLog) => {
            // console.log('resForLog:', resForLog);
            _messages.push({ role: "assistant", content: resForLog });
            if (nickName && authResult.ip && authResult.code) {
              sql`insert into web_log (nickname, ip, createtime, messages, temperature, uuid) VALUES (${nickName}, ${authResult.ip}, ${_createtime_}, ${_messages}, ${reqForLog.temperature}, ${authResult.code})`.catch(
                (e) => {
                  console.log("[OpenAI Log] sql insert error: ", e);
                },
              );
            } else {
              console.log(
                "[OpenAI Log] Missing required parameters for sql query",
              );
            }
          })
          .catch((e) => {
            console.log("[OpenAI Log] response exact error: ", e);
          });
      })
      .catch((e) => {
        console.log("[OpenAI Log] request read error: ", e);
      });
    // list models
    if (subpath === OpenaiPath.ListModelPath && response.status === 200) {
      const resJson = (await response.json()) as OpenAIListModelResponse;
      const availableModels = getModels(resJson);
      return NextResponse.json(availableModels, {
        status: response.status,
      });
    }

    return response;
  } catch (e) {
    console.error("[OpenAI] ", e);
    return NextResponse.json(prettyObject(e));
  }
}

export const GET = handle;
export const POST = handle;

// edge 环境不支持 tcp 连接导致 postgressql 无法使用
// export const runtime = "edge";
export const preferredRegion = [
  "arn1",
  "bom1",
  "cdg1",
  "cle1",
  "cpt1",
  "dub1",
  "fra1",
  "gru1",
  "hnd1",
  "iad1",
  "icn1",
  "kix1",
  "lhr1",
  "pdx1",
  "sfo1",
  "sin1",
  "syd1",
];
