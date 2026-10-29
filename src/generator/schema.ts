import { z } from "zod";

export const TEST_CATEGORIES = ["normal", "edge", "error"] as const;

export const GeneratedTestCaseSchema = z.object({
  name: z.string().describe("Short description of the behavior under test, used as the `it` title"),
  category: z.enum(TEST_CATEGORIES).describe("normal: typical input; edge: boundaries and unusual input; error: throws or rejects"),
  body: z.string().describe("Statements inside the test callback, without the it() wrapper"),
});

export const GeneratedSuiteSchema = z.object({
  functionName: z.string().describe("Binding name of the function under test, exactly as listed in the prompt"),
  cases: z.array(GeneratedTestCaseSchema),
});

export const GenerationSchema = z.object({
  suites: z.array(GeneratedSuiteSchema),
});

export type GeneratedTestCase = z.infer<typeof GeneratedTestCaseSchema>;
export type GeneratedSuite = z.infer<typeof GeneratedSuiteSchema>;
export type Generation = z.infer<typeof GenerationSchema>;
