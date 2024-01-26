import { isMessageReceive, isVerification } from "./utils.ts";

const APP_ID = Deno.env.get("APP_ID");
const APP_SECRET = Deno.env.get("APP_SECRET");
const APP_VERIFICATION_TOKEN = Deno.env.get("APP_VERIFICATION_TOKEN");

async function handleRequest(request: Request) {
  // 只接收 POST 请求
  if (request.method.toUpperCase() !== "POST") {
    if (!APP_ID || !APP_SECRET || !APP_VERIFICATION_TOKEN) {
      return new Response(
        "请先设置 APP_ID、APP_SECRET、APP_VERIFICATION_TOKEN 环境变量",
        {
          status: 200,
          headers: { "content-type": "text/plain" },
        }
      );
    }

    return send();
  }

  const body = await request.json();

  console.log(body);

  if (isVerification(body)) {
    // 校验 verification token 是否匹配，token 不匹配说明该回调并非来自开发平台
    if (body.token !== APP_VERIFICATION_TOKEN) {
      console.warn(`verification token not match, token = %s`, body.token);
      return send();
    }
    return send({ challenge: body.challenge });
  }

  if (
    body.event.text_without_at_bot &&
    body.event.text_without_at_bot.match("/roll")
  ) {
    const matches = body.event.text_without_at_bot
      .replace(/<.*?>/g, "")
      .match(/\d+/);
    const accessToken = await getTenantAccessToken();
    let ids = await getReactions(accessToken, body.event.parent_id);
    const set = new Set(ids);
    ids = Array.from(set);
    const resultArray: any = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const name = await oidToName(accessToken, id);
      const roll = await randomInts(1, 1000, 1);
      resultArray.push({ name, roll });
    }
    resultArray.sort((a: any, b: any) => b.roll - a.roll);
    const result = resultArray
      .map(
        (item: any, index: number) =>
          `${index + 1}：${item.name}-${item.roll}点`
      )
      .join("\n");
    await sendMessage(
      accessToken,
      body.event.open_chat_id,
      `抽${matches}个，roll点结果排序：\n\n${result}`
    );
    // await randomInts(1, 1000, 1)
    //     .then(async (result) => {
    //         return sendMessage(
    //             accessToken,
    //             body.event.open_chat_id,
    //             `${await oidToName(accessToken, body.event.user_open_id)} ${result[0]}(1-1000)`,
    //         )
    //     })
  } else if (
    body.event.text_without_at_bot &&
    body.event.parent_id.length > 0
  ) {
    const accessToken = await getTenantAccessToken();
    const matches = body.event.text_without_at_bot
      .replace(/<.*?>/g, "")
      .match(/\d+/);
    let text = "";
    if (matches) {
      let ids = await getReactions(accessToken, body.event.parent_id);
      const set = new Set(ids);
      ids = Array.from(set);
      await randomInts(0, ids.length - 1, matches[0])
        .then((result) => {
          text = `抽奖公示：\n\n抽奖总人数${ids.length}，抽${matches[0]}人\n中奖序号：${result}\n\n`;
          return result;
        })
        .then((result) => result.map((index) => ids[index]))
        .then((ids) => Promise.all(ids.map((id) => oidToName(accessToken, id))))
        .then((names) =>
          sendMessage(
            accessToken,
            body.event.open_chat_id,
            `${text}获奖名单：\n\n${names.join("\n")}`
          )
        )
        .catch((err) => {
          sendMessage(
            accessToken,
            body.event.open_chat_id,
            "抽奖失败，请检查参数后重试"
          );
          console.error(err);
        });
    }
  }

  if (isMessageReceive(body)) {
    // 此处只处理 text 类型消息，其他类型消息忽略
    if (body.event.message.message_type !== "text") {
      return send();
    }

    // 在群聊中，只有被 at 了才回复
    if (
      body.event.message.chat_type === "group" &&
      !body.event.message.mentions?.some(
        (x) => x.id.union_id === "on_e6b1f3bc2177c86d5d5f7858700b7972 aaa"
      )
    ) {
      return send();
    }

    const accessToken = await getTenantAccessToken();
    if (accessToken === "") {
      console.warn(`verification token not match, token = %s`, accessToken);
      return send();
    }
    const mentions = body.event.message.mentions;
    let { text } = JSON.parse(body.event.message.content);

    if (mentions != null) {
      text = text.replace(/@_user_\d/g, (key: string) => {
        const user = mentions.find((x) => x.key === key);
        if (user === undefined) return key;
        return `<at user_id="${user.id.open_id}">${user.name}</at>`;
      });
    }

    await sendMessage(accessToken, body.event.message.chat_id, text);
    return send();
  }

  return send();
}

async function getTenantAccessToken() {
  const response = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/",
    {
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
      body: JSON.stringify({
        app_id: APP_ID,
        app_secret: APP_SECRET,
      }),
    }
  );

  if (!response.ok) {
    return send();
  }

  const body = await response.json();

  if (body.code !== 0) {
    console.log("get tenant_access_token error, code = %d", body.code);
    return "";
  }

  return body.tenant_access_token ?? "";
}

async function oidToName(token: string, oid: string) {
  return fetch(`https://open.feishu.cn/open-apis/contact/v3/users/${oid}`, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: "Bearer " + token,
    },
    method: "GET",
  })
    .then((response) => response.json())
    .then((body) => {
      console.log(body);
      return body;
    })
    .then((body) => `<at user_id="${oid}">${body.data.user.name}</at>`);
}

async function getReactions(
  token: string,
  message_id: string,
  pageToken: string = ""
) {
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${message_id}/reactions`;
  const response = await fetch(
    pageToken.length > 0 ? `${url}?page_token=${pageToken}` : url,
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: "Bearer " + token,
      },
      method: "GET",
    }
  );

  if (!response.ok) {
    return [];
  }

  const body = await response.json();
  console.log(body);
  const result = body.data.items.map((item) => item.operator.operator_id);
  if (body.data.has_more) {
    return result.concat(
      await getReactions(token, message_id, body.data.page_token)
    );
  } else {
    return result;
  }
}

async function randomInts(min: number, max: number, n: number) {
  return fetch("https://api.random.org/json-rpc/2/invoke", {
    headers: {
      "content-type": "application/json; charset=UTF-8",
    },
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "generateIntegers",
      params: {
        replacement: false,
        min,
        max,
        n,
      },
      id: 1,
    }),
  })
    .then(async function (res) {
      const json = await res.json();
      console.log(json);
      return json;
    })
    .then((res) => res.result.random.data);
}

async function sendMessage(token: string, receive_id: string, text: string) {
  const response = await fetch(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: "Bearer " + token,
      },
      method: "POST",
      body: JSON.stringify({
        receive_id,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    }
  );

  if (!response.ok) {
    return send();
  }

  const body = await response.json();

  if (body.code !== 0) {
    console.log("send message error, code = %d, msg = %s", body.code, body.msg);
    return "";
  }
}

function send(body = {}) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=UTF-8",
    },
  });
}

addEventListener("fetch", (event: FetchEvent) => {
  console.log("event", event);
  event.respondWith(handleRequest(event.request));
});
