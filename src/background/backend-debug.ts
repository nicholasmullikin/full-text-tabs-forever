import { formatDebuggablePayload } from "../common/utils";
import { Article, Backend, DetailRow, RemoteProcWithSender } from "./backend";

export class DebugBackend implements Backend {
  getStatus: Backend["getStatus"] = async () => {
    return {
      ok: true,
    };
  };

  search: Backend["search"] = async (search) => {
    console.log(`backend#%c${"search"}`, "color:lime;", search);
    return {
      ok: true,
      results: [],
      count: 0,
      perfMs: 0,
    };
  };

  async findOne(query: { where: { url: string } }): Promise<DetailRow | null> {
    console.log(`backend#%c${"findOne"}`, "color:lime;", query);
    return null;
  }

  getPageStatus: Backend["getPageStatus"] = async (payload, sender) => {
    const { tab } = sender;
    let shouldIndex = tab?.url?.startsWith("http"); // ignore chrome extensions, about:blank, etc

    try {
      const url = new URL(tab?.url || "");
      if (url.hostname === "localhost") shouldIndex = false;
      if (url.hostname.endsWith(".local")) shouldIndex = false;
    } catch (err) {
      // should not happen
      throw err;
    }

    console.log(`%c${"getPageStatus"}`, "color:lime;", { shouldIndex, url: tab?.url }, payload);

    return {
      shouldIndex,
    };
  };

  indexPage: Backend["indexPage"] = async (payload, sender) => {
    const { tab } = sender;

    // remove adjacent whitespace since it serves no purpose. The html or
    // markdown content stores formatting.
    const plainText = payload.textContent.replace(/[ \t]+/g, " ").replace(/\n+/g, "\n");

    console.log(`%c${"indexPage"}`, "color:lime;", tab?.url);
    console.log(formatDebuggablePayload({ ...payload, textContent: plainText }));
    return {
      message: "debug backend does not index pages",
    };
  };

  nothingToIndex: Backend["nothingToIndex"] = async (payload, sender) => {
    const { tab } = sender;
    console.log(`%c${"nothingToIndex"}`, "color:beige;", tab?.url);
    return {
      ok: true,
    };
  };
}
