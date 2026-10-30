import { z } from "zod";

export const REPAIR_ACTIONS = ["fix", "skip", "remove"] as const;

export const RepairSchema = z.object({
  repairs: z.array(
    z.object({
      functionName: z.string().describe("Binding name of the function, exactly as given"),
      name: z.string().describe("Test name, exactly as given"),
      action: z
        .enum(REPAIR_ACTIONS)
        .describe("fix: rewrite the body; skip: the test is right and the source looks buggy; remove: the test cannot be made reliable"),
      body: z.string().describe("The corrected test body for fix; an empty string otherwise"),
      reason: z.string().describe("One sentence explaining the failure and the change"),
    }),
  ),
});

export type RepairResponse = z.infer<typeof RepairSchema>;
export type RepairAction = (typeof REPAIR_ACTIONS)[number];
