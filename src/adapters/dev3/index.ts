// Barrel for the dev-3.0 board adapters: Dev3RpcReader (reads via the socket) + Dev3CliBoard
// (mutations via the `dev3` CLI), plus the socket client and pure store→Card mapper.

export { Dev3CliBoard, type Dev3CliBoardOptions } from "./board.ts";
export { Dev3RpcReader, type Dev3RpcReaderOptions } from "./reader.ts";
export { rpc, findSocket } from "./rpc.ts";
export { taskToCard, shortId, type Dev3Task, type Dev3Project } from "./map.ts";
