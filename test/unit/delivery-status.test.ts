import { expect, test } from "bun:test";
import { taskDeclaration } from "../../scripts/delivery-status.ts";
import { redactEvidence } from "../../scripts/integration-test-run.ts";

test("task declarations distinguish missing tasks from checked tasks and reject duplicate ids", () => {
  expect(taskDeclaration("No tasks").declaration).toBe("missing_tasks");
  expect(taskDeclaration("- [x] 1.1 完成\n- [ ] 1.12（外部）未完成\n- [X] 2.1 Done")).toEqual({
    total: 3, checked: 2, unchecked_ids: ["1.12"], declaration: "open_tasks" });
  expect(taskDeclaration("- [x] 1.1 Done").declaration).toBe("all_checked");
  expect(() => taskDeclaration("- [x] 1.1 Done\n- [ ] 1.1 Duplicate")).toThrow("Duplicate");
});

test("PostgreSQL URLs are redacted even when not introduced by a password label", () => {
  expect(redactEvidence("target=postgres://sample:synthetic-password@localhost:5432/test?sslmode=disable\npostgresql://sample@localhost/test")).toBe("target=[REDACTED]\n[REDACTED]");
});
