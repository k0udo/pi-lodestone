export type DecisionSource = "manual" | "extracted" | "turn";

export type Decision = {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  project: string;
  source: DecisionSource;
  title: string;
  text: string;
  tags: string[];
  important: boolean;
  archived: boolean;
  kbPath?: string;
  sourceTurnId?: string;
  supersedes?: string[];
  supersededBy?: string;
  conflictsWith?: string[];
  retrievalCount: number;
  injectionCount: number;
  lastRetrievedAt?: string;
  lastInjectedAt?: string;
};

export type DecisionPatch = Partial<Pick<Decision, "title" | "text" | "tags" | "important" | "archived" | "kbPath" | "supersedes" | "supersededBy" | "conflictsWith" | "lastRetrievedAt" | "lastInjectedAt" | "retrievalCount" | "injectionCount">>;

export type Settings = {
  disabledProjects?: string[];
};
