import assert from "node:assert/strict";
import test from "node:test";
import { parseGeneralComputeModelList, parseOpenAiModelList, resolveHostModel } from "./host-catalog.js";

test("OpenAI-style host catalogs keep unique safe IDs and fail closed on junk", () => {
  const models = parseOpenAiModelList({
    data: [
      { id: "minimax-m2.7", name: "MiniMax M2.7" },
      { id: "minimax-m2.7" },
      { id: "bad\nid" },
      { id: "" },
      { name: "no-id" },
    ],
  });
  assert.deepEqual(models, [{ id: "minimax-m2.7", name: "MiniMax M2.7" }]);
  assert.throws(() => parseOpenAiModelList({ models: [] }), /missing its data array/);
  assert.throws(() => resolveHostModel(models, "nope", "GeneralCompute"), /not in the current GeneralCompute catalog/);
});

test("GeneralCompute models/list payloads accept either data or models arrays", () => {
  const fromModels = parseGeneralComputeModelList({ models: [{ id: "alpha" }, { id: "beta", name: "Beta" }] });
  assert.deepEqual(fromModels.map((model) => model.id), ["alpha", "beta"]);
  const fromData = parseGeneralComputeModelList({ data: [{ id: "gamma" }] });
  assert.equal(fromData[0]?.id, "gamma");
});
