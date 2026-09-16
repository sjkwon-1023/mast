import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const token = /^[A-Za-z0-9_-]+$/;
const tab = process.env.MAST_TAB;
const enabled = process.env.MAST === "1" && /^[0-9]+$/.test(tab ?? "");

export const Mast = async ({ client, directory, $ }) => {
  if (!enabled) return {};

  const known = new Map();
  const pending = new Set();
  let activeRoot;
  let lastStatus;
  let queue = Promise.resolve();

  function remember(id, isRoot) {
    if (!token.test(id ?? "")) return;
    known.delete(id);
    known.set(id, isRoot);
    if (known.size > 64) known.delete(known.keys().next().value);
  }

  async function isRoot(id, info) {
    if (!token.test(id ?? "")) return false;
    if (info && info.id === id) {
      const root = !info.parentID;
      remember(id, root);
      return root;
    }
    if (known.has(id)) return known.get(id);
    try {
      const result = await client.session.get({ path: { id }, query: { directory } });
      if (result.error || result.data?.id !== id) return false;
      const root = !result.data.parentID;
      remember(id, root);
      return root;
    } catch {
      return false;
    }
  }

  async function record(id, force = false) {
    if (!token.test(id ?? "") || (activeRoot === id && !force)) return;
    const folder = join(process.env.HOME, ".mast", "resume");
    const target = join(folder, `tab-${tab}`);
    const temporary = `${target}.tmp.${process.pid}`;
    try {
      await mkdir(folder, { recursive: true });
      await writeFile(temporary, `opencode --session ${id}\n${Math.floor(Date.now() / 1000)}\n`);
      await rename(temporary, target);
      activeRoot = id;
    } catch {
      // 힌트 기록 실패가 상태 알림을 막으면 사용자가 입력 대기를 놓친다.
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function emit(status, body) {
    if (lastStatus === status) return;
    await $`"${process.env.HOME}/.mast/bin/mast-notify.sh" ${status} ${body} < /dev/null`
      .quiet().nothrow();
    lastStatus = status;
  }

  async function handle(event) {
    const { type, properties = {} } = event;
    const id = properties.sessionID ?? properties.info?.id;
    if (type === "session.created" || type === "session.updated") {
      if (await isRoot(id, properties.info)) await record(id);
      return;
    }
    if (!id || !token.test(id)) return;
    const root = await isRoot(id);
    if (root) {
      const status = properties.status?.type;
      const enteringBusy = type === "session.status" && (status === "busy" || status === "retry")
        && lastStatus !== "mast:running";
      const enteringIdle = (type === "session.idle" || (type === "session.status" && status === "idle"))
        && lastStatus !== "mast:idle";
      await record(id, enteringBusy || enteringIdle);
    }

    if (type === "permission.asked" || type === "question.asked") {
      const request = properties.id;
      if (request && pending.size < 64) pending.add(request);
      await emit("mast:needsInput", "opencode needs input");
    } else if (type === "permission.replied" || type === "question.replied" || type === "question.rejected") {
      pending.delete(properties.requestID);
      if (!pending.size) await emit("mast:running", "opencode running");
    } else if (type === "session.status" && (properties.status?.type === "busy" || properties.status?.type === "retry")) {
      if (root && !pending.size) await emit("mast:running", "opencode running");
    } else if (root && (type === "session.idle" || (type === "session.status" && properties.status?.type === "idle"))) {
      if (!pending.size) await emit("mast:idle", "opencode idle");
    }
  }

  return {
    event({ event }) {
      queue = queue.then(() => handle(event), () => handle(event)).catch(() => {});
    },
  };
};
