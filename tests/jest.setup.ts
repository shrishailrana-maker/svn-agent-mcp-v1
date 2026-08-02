import { afterAll } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const operationDirectory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "svn-agent-jest-operations-"));
process.env.SVN_MCP_OPERATION_DIR = operationDirectory;

afterAll(() => {
  fs.rmSync(operationDirectory, { recursive: true, force: true });
});
