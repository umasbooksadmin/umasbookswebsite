// A "sink" for streaming a long response (a CSV download) one chunk at a time:
// sink(text) writes the chunk and, when the response's buffer is full, returns a
// promise that settles once it has drained (or the client went away), so the
// caller can await it and never builds up memory.
//
// One "drain" listener serves the whole download. The earlier code added a new
// res.once("drain") for every full buffer: with the compression middleware,
// res.once() ends up on the compressor stream and is never removed, so a big
// download piled up listeners until Node printed MaxListenersExceededWarning.
function drainingSink(res) {
  let waiting = [];
  const release = () => {
    const resolvers = waiting;
    waiting = [];
    for (const resolve of resolvers) resolve();
  };
  res.on("drain", release);
  res.once("close", release); // a client that disconnected will never drain: do not wait for it forever
  return (text) => {
    if (res.destroyed || res.writableEnded) return undefined;
    if (res.write(text)) return undefined;
    return new Promise((resolve) => waiting.push(resolve));
  };
}

module.exports = { drainingSink };
