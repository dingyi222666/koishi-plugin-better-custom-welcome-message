import { Awaitable, Computed, Context, h, Schema, Session } from "koishi";
import { transform } from "koishi-plugin-markdown";

export const name = "better-custom-welcome-message";

export interface Config {
  custom_welcome_messages: string[];
  custom_leave_messages: string[];

  //  Computed<Awaitable<number>>
  welcome_group_selector: Computed<Awaitable<number>>;
  leave_group_selector: Computed<Awaitable<number>>;
}

export const usage = `此插件提供了自定义群组欢迎/离开消息的功能

## 消息格式

消息整体使用 markdown，并且扩展支持以下变量：

- \`{user}\`：用户昵称
- \`{id}\`：用户 QQ 号
- \`{group_id}\`：群组 ID
- \`{group}\`：群组名称
- \`{time}\`：当前时间
- \`{at}\`：at 该用户
- \`{avatar}\`：用户头像
- \`{group_count}\`：群组人数
- \`{hitokoto}\`：一言

对于图片，可直接使用 markdown 的图片格式来发送图片。
(本地图片路径需要加上 file:// 前缀，如 file://C:/Users/xxx/Pictures/xxx.jpg)

## 选择消息

我们支持添加多个消息，所以我们也支持选择目标消息的功能。

你可以使用计算属性对不同的群组选择不同的消息，为 0 则是随机选择。否则则选择对应的消息。
如有 2 条入群消息，在配置项里你输入的是 1，那么就会选择第一条消息。


## 在指定的群组启用

你可以在插件上方使用过滤器来指定在哪些群组启用此插件。
`;

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    welcome_group_selector: Schema.union([
      Schema.natural(),
      Schema.any().hidden(),
    ])
      .role("computed")
      .default(0)
      .description("欢迎消息选择器"),
    leave_group_selector: Schema.union([
      Schema.natural(),
      Schema.any().hidden(),
    ])
      .role("computed")
      .default(0)
      .description("离开消息选择器"),
  }).description("群组配置"),

  Schema.object({
    custom_welcome_messages: Schema.array(Schema.string().role("textarea"))
      .default([`{at} 欢迎 {user} 加入 {group}，送你一句话吧：{hitokoto}`])
      .description("欢迎消息"),
    custom_leave_messages: Schema.array(
      Schema.string().role("textarea"),
    ).default([`{user} 离开了 {group}。真是可惜，让我们一起祝福他吧。`]),
  }).description("消息配置"),
]);

export function apply(ctx: Context, config: Config) {
  ctx.on("guild-member-added", async (session) => {
    const message = await selectMessage(session, config, EventType.ADD);

    if (!message) {
      return;
    }

    await session.send(await formatMessage(ctx, session, message));
  });

  ctx.on("guild-member-removed", async (session) => {
    const message = await selectMessage(session, config, EventType.LEAVE);

    if (!message) {
      return;
    }

    await session.send(await formatMessage(ctx, session, message));
  });
}

async function formatMessage(
  ctx: Context,
  session: Session,
  markdownText: string,
): Promise<h[]> {
  // 预先处理一些可直接处理的变量

  const guildId = session.event.guild?.id ?? session.guildId;
  const userId = session.author?.id ?? session.event.user?.id ?? session.userId;
  const groupName =
    (await session.bot.getGuild(guildId)).name ??
    session.event.guild?.name ??
    "";

  const groupMemberList = await session.bot.getGuildMemberList(guildId);

  let groupMemberCount: number;

  // 兼容旧版本

  if (groupMemberList instanceof Array) {
    groupMemberCount = groupMemberList.length;
  } else {
    groupMemberCount = groupMemberList.data.length;
  }

  const avatar =
    (session.bot.platform === "onebot" || session.bot.platform === "red") &&
    userId != null
      ? `https://q.qlogo.cn/headimg_dl?dst_uin=${session.userId?.toString()}&spec=640`
      : session.author.avatar;

  markdownText = markdownText
    .replace(
      /{user}/g,
      getNotEmptyText(session.author.nick,
        session.author.name,
        session.event.user.name,
        session.username),
    )
    .replace(/{group}/g, groupName)
    .replace(/{time}/g, new Date().toLocaleString())
    .replace(/{avatar}/g, `![avatar](${avatar ?? ""})`)
    .replace(/{id}/g, userId ?? "")
    .replace(/{group_id}/g, guildId ?? "")
    .replace(/{group_count}/g, groupMemberCount.toString())
    .replace(/{hitokoto}/g, await hitokoto(ctx));

  const transformed = transform(markdownText);

  const finalElements: h[] = [];

  for (const element of transformed) {
    transformElements(session, element, finalElements);
  }

  return finalElements;
}

function transformElement(session: Session, element: h, parent: h[]) {
  if (element.type !== "text") {
    return;
  }

  let text = element.attrs.content as string;

  // 匹配第一个 {at}，并且把之前和之后的都分开，然后一次次循环替换直到没有 {at} 为止

  while (true) {
    const index = text.indexOf("{at}");

    if (index === -1) {
      break;
    }

    const before = text.slice(0, index);
    const after = text.slice(index + 4);

    parent.push(h.text(before));
    parent.push(h.at(session.userId));

    text = after;
  }
  parent.push(h.text(text));
}

function transformElements(session: Session, element: h, parent: h[]) {
  if (element.type === "text") {
    transformElement(session, element, parent);
    return;
  }
  const resultElement: h = h.jsx(element.type, element.attrs);

  resultElement.children = [];
  resultElement.source = element.source;

  for (const child of element.children) {
    transformElements(session, child, resultElement.children);
  }

  parent.push(resultElement);
}

async function selectMessage(
  session: Session<never, never>,
  config: Config,
  eventType: EventType,
) {
  const messages =
    eventType === EventType.ADD
      ? config.custom_welcome_messages
      : config.custom_leave_messages;

  if (messages.length === 0) {
    return;
  }

  const selector =
    eventType === EventType.ADD
      ? config.welcome_group_selector
      : config.leave_group_selector;

  const index = await session.resolve(selector);

  if (index === 0) {
    return messages[Math.floor(Math.random() * messages.length)];
  } else {
    return messages?.[index - 1] ?? messages[0];
  }
}

function getNotEmptyText(...texts: string[]) {
  for (const text of texts) {
    if (text != null && text.length > 0) {
      return text;
    }
  }
  return "";
}

async function hitokoto(ctx: Context) {
  for (let i = 0; i < 3; i++) {
    try {
      const response = await ctx.http.get("https://v1.hitokoto.cn");
      return response.hitokoto;
    } catch (e) {
      if (i === 2) {
        throw e;
      }
    }
  }
}

enum EventType {
  ADD = 0,
  LEAVE = 1,
}
