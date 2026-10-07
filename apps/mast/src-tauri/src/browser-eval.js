const __mastEvalError = (value) => {
  let name = "Error";
  let message;
  // getter 가 읽을 때마다 다른 값을 줄 수 있어 각 속성은 한 번만 읽는다.
  try {
    const candidate = value != null ? value.name : undefined;
    if (typeof candidate === "string" && candidate) name = candidate;
  } catch {}
  try {
    const candidate = value != null && (typeof value === "object" || typeof value === "function") ? value.message : undefined;
    message = typeof candidate === "string" ? candidate : String(value);
  } catch {
    message = "[exception message unavailable]";
  }
  return {name, message};
};

const __mastEvalErrorPayload = (code, value) => {
  const normalized = __mastEvalError(value);
  const truncateUtf8 = (text, limit) => {
    let result = "";
    let bytes = 0;
    for (const character of text) {
      const point = character.codePointAt(0);
      const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (bytes + size > limit) break;
      result += character;
      bytes += size;
    }
    return result;
  };
  const name = truncateUtf8(normalized.name, 256);
  let message = truncateUtf8(normalized.message, 4096);
  let payload = JSON.stringify({error: {code, name, message}});
  if (new TextEncoder().encode(payload).length > 8192) {
    message = truncateUtf8(message, 1024);
    payload = JSON.stringify({error: {code, name, message}});
  }
  if (new TextEncoder().encode(payload).length > 8192) {
    return JSON.stringify({error: {code, name: "Error", message: "Page script failed"}});
  }
  return payload;
};

const __mastEvalRejected = (await (async () => {
  try {
    return {value: await (
__MAST_EVAL_EXPRESSION__
    )};
  } catch (error) {
    return {error: __mastEvalError(error)};
  }
})());

if (__mastEvalRejected.error) {
  return __mastEvalErrorPayload("script_error", __mastEvalRejected.error);
}

let __mastEvalJson;
try {
  __mastEvalJson = JSON.stringify(__mastEvalRejected.value);
} catch (error) {
  return __mastEvalErrorPayload("serialization_error", error);
}
if (__mastEvalJson === undefined) __mastEvalJson = "null";

const __mastEvalResponse = `{"value":${__mastEvalJson}}`;
if (new TextEncoder().encode(__mastEvalResponse).length > 1048576) {
  return JSON.stringify({error: {code: "too_large"}});
}
return __mastEvalResponse;
