export { generateTests, GenerationError, type GenerationResult } from "./testGenerator.js";
export { planMocks, PURE_BUILTINS, PURE_PACKAGES, type MockedModule, type MockPlan, type RealModule } from "./mocks.js";
export { previewPathFor, renderTestFile, testPathFor, writeTestFile, TestFileExistsError } from "./testWriter.js";
export { unifiedDiff } from "./diff.js";
export { checkBody, type AcceptedCase, type ValidatedSuite } from "./validate.js";
