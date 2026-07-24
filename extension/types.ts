export type DecisionSource = "manual" | "extracted" | "turn";

export type ProjectRecord = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  roots: string[];
  contextPaths?: string[];
  artifactPaths?: string[];
  archived: boolean;
};

export type ProjectRegistry = {
  activeProjectId?: string;
  projects: ProjectRecord[];
};

export type Decision = {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  project: string;
  projectId?: string;
  source: DecisionSource;
  title: string;
  text: string;
  tags: string[];
  scope?: "global" | "project" | "repo" | "host" | "tool" | "workflow" | "model" | "engagement";
  key?: string; // short_snake_case_identifier
  summary?: string;
  details?: string[];
  confidence?: "high" | "medium" | "low";
  freshness?: "current" | "may_be_stale" | "stale";
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

export type DecisionPatch = Partial<Pick<Decision, "title" | "text" | "tags" | "projectId" | "scope" | "key" | "summary" | "details" | "confidence" | "freshness" | "important" | "archived" | "kbPath" | "supersedes" | "supersededBy" | "conflictsWith" | "lastRetrievedAt" | "lastInjectedAt" | "retrievalCount" | "injectionCount">>;

export type Settings = {
  disabledProjects?: string[];
  disabledProjectIds?: string[];
};
