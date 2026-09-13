import type { Analysis } from "../../src/domain/contracts";
import type { AnalysisContext, AnalysisErrorCode } from "../../src/services/analyze";
import { citation } from "./fixtures";

export type ExpectedOutcome = "CREATE_ISSUE" | "ADD_PROGRESS_COMMENT" | AnalysisErrorCode;
type GoldFact = [text: string, messageIndex: number];
type GoldTask = [text: string, messageIndex: number, owner?: string | null, deadline?: string | null];
export interface Annotation {
  outcome: ExpectedOutcome;
  decisions?: GoldFact[];
  tasks?: GoldTask[];
  blockers?: GoldFact[];
  uncertaintyIncludes?: string[];
  assignees?: string[];
}

// Human-authored reference labels. Never derive labels from response tapes or
// analyzeThread results. Evaluation inputs must never receive these annotations.
export function evaluationAnnotations(): Record<string, Annotation> {
  return {
    E01: { outcome: "CREATE_ISSUE", tasks: [["document the release checklist", 0, "U_ANA", "Friday"]],
      assignees: ["synthetic-ana"], uncertaintyIncludes: ["Deadline wording is unresolved: Friday"] },
    E02: { outcome: "ADD_PROGRESS_COMMENT", decisions: [["The retry guard is ready", 0]] },
    E03: { outcome: "CREATE_ISSUE", decisions: [["keep the cache optional", 0]] },
    E04: { outcome: "CREATE_ISSUE", blockers: [["staging credentials have expired", 0]] },
    E05: { outcome: "CREATE_ISSUE", tasks: [["review the timeout budget", 0, "U_ANA", "17:00 America/Mexico_City"]],
      assignees: ["synthetic-ana"], uncertaintyIncludes: ["Deadline wording is unresolved: 17:00 America/Mexico_City"] },
    E06: { outcome: "CREATE_ISSUE", tasks: [["benchmark the parser", 0, "U_CARLOS", "next Friday"]],
      assignees: ["synthetic-carlos"], uncertaintyIncludes: ["Which calendar date next Friday means is ambiguous", "Deadline wording is unresolved: next Friday"] },
    E07: { outcome: "CREATE_ISSUE", tasks: [["audit the export columns", 0]] },
    E08: { outcome: "CREATE_ISSUE", tasks: [["validate the archive headers", 0]], uncertaintyIncludes: ["The owner is ambiguous"] },
    E09: { outcome: "CREATE_ISSUE", tasks: [["inspect the queue drain", 0, "U_GUEST"]],
      uncertaintyIncludes: ["No GitHub identity mapping for Slack user U_GUEST"] },
    E10: { outcome: "CREATE_ISSUE", tasks: [["compare the token counters", 0, "U_CARLOS"]], assignees: ["synthetic-carlos"] },
    E11: { outcome: "CREATE_ISSUE", decisions: [["capture retry metrics", 0]] },
    E12: { outcome: "CREATE_ISSUE", tasks: [["inspect the tail latency", 0]], uncertaintyIncludes: ["No deadline was agreed"] },
    E13: { outcome: "CREATE_ISSUE", blockers: [["the schema review is pending", 0]] },
    E14: { outcome: "CREATE_ISSUE", decisions: [["retain manual review", 0]],
      tasks: [["reproduce the callback race", 1, "U_CARLOS", "tomorrow"]], blockers: [["the trace sample is missing", 2]],
      assignees: ["synthetic-carlos"], uncertaintyIncludes: ["Deadline wording is unresolved: tomorrow"] },
    E15: { outcome: "CREATE_ISSUE", tasks: [["audit the quota guard", 0, "U_ANA"], ["document the replay procedure", 1, "U_CARLOS", "Tuesday"]],
      assignees: ["synthetic-carlos"], uncertaintyIncludes: ["Deadline wording is unresolved: Tuesday"] },
    E16: { outcome: "CREATE_ISSUE", tasks: [["inspect the log rotation", 0]], uncertaintyIncludes: ["No owner was assigned"] },
    E17: { outcome: "analysis_no_action", uncertaintyIncludes: ["No actionable work was requested"] },
    E18: { outcome: "analysis_model_invalid" },
    E19: { outcome: "analysis_target_invalid" },
    E20: { outcome: "analysis_target_invalid" },
    E21: { outcome: "analysis_target_invalid" },
    E22: { outcome: "analysis_target_invalid" },
    E23: { outcome: "analysis_provider_unavailable" },
    E24: { outcome: "analysis_model_invalid" },
    E25: { outcome: "analysis_model_invalid" },
    E26: { outcome: "analysis_model_invalid" },
    E27: { outcome: "analysis_model_invalid" },
    E28: { outcome: "analysis_model_invalid" },
    E29: { outcome: "analysis_invalid_context" },
    E30: { outcome: "analysis_invalid_context" },
    E31: { outcome: "analysis_invalid_context" },
    E32: { outcome: "analysis_model_invalid" },
    E33: { outcome: "CREATE_ISSUE", tasks: [["check the channel binding", 0]] },
    E34: { outcome: "CREATE_ISSUE", tasks: [["inspect the retry envelope", 0, "U_CARLOS", "Wednesday"]],
      assignees: ["synthetic-carlos"], uncertaintyIncludes: ["Deadline wording is unresolved: Wednesday"] },
  };
}

export function annotatedAnalysis(context: AnalysisContext, annotation: Annotation): Analysis {
  return {
    decisions: (annotation.decisions ?? []).map(([text, index]) => ({ text, evidence: [citation(context, index)] })),
    tasks: (annotation.tasks ?? []).map(([text, index, ownerSlackId = null, deadlineText = null]) => ({
      text, evidence: [citation(context, index)], ownerSlackId, deadlineText,
    })),
    blockers: (annotation.blockers ?? []).map(([text, index]) => ({ text, evidence: [citation(context, index)] })),
    uncertainties: [],
  };
}
