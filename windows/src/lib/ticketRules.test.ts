import { describe, expect, it } from "vitest";
import { fixedProject, suggestForTicket, taskForOrganization } from "./ticketRules";
import type { Project, TimeEntry } from "./models";

const serviceDesk: Project = { id: "sd", name: "CS - Service Desk", client: { id: "c1", name: "Customer support" } };
const otherDesk: Project = { id: "sd2", name: "Service desk (old)", client: { id: "c2", name: "Internal" } };
const internal: Project = { id: "int", name: "Internal hours", client: { id: "c3", name: "Example Co" } };
const mosaic: Project = { id: "mos", name: "Rollout", client: { id: "c4", name: "Acme" } };
const projects = [internal, otherDesk, serviceDesk, mosaic];

const entry = (key: string, projectId: string, taskId: string, taskName = "Task"): TimeEntry => ({
  id: `${key}-${projectId}`,
  project_id: projectId,
  task: { id: taskId, name: taskName },
  task_id: taskId,
  external_reference: { id: key },
});

describe("fixedProject: CSD always books on Service Desk", () => {
  it("finds the service-desk project by name, preferring the Customer support client", () => {
    expect(fixedProject("CSD-1234", projects)?.id).toBe("sd");
    expect(fixedProject("csd-9", projects)?.id).toBe("sd");
  });
  it("takes the only one when there is no client match", () => {
    expect(fixedProject("CSD-1", [internal, otherDesk])?.id).toBe("sd2");
  });
  it("nothing for other prefixes, or without a service-desk project", () => {
    expect(fixedProject("MOS-12", projects)).toBeUndefined();
    expect(fixedProject("CSD-1", [internal, mosaic])).toBeUndefined();
  });
});

describe("suggestForTicket", () => {
  it("CSD without history → Service Desk, fixed", () => {
    const s = suggestForTicket("CSD-1", projects, []);
    expect(s?.project.id).toBe("sd");
    expect(s?.fixed).toBe(true);
    expect(s?.task).toBeUndefined();
  });

  it("CSD wins over another project you used for that prefix", () => {
    const s = suggestForTicket("CSD-2", projects, [entry("CSD-1", "int", "t-int")]);
    expect(s?.project.id).toBe("sd");
  });

  it("the same ticket logged before → same project and task (the customer)", () => {
    const s = suggestForTicket("CSD-5", projects, [entry("CSD-5", "sd", "t-acme", "Acme")]);
    expect(s?.project.id).toBe("sd");
    expect(s?.task).toEqual({ id: "t-acme", name: "Acme" });
    expect(s?.fixed).toBe(true);
  });

  it("an old CSD entry on another project is ignored: CSD stays Service Desk", () => {
    const s = suggestForTicket("CSD-5", projects, [entry("CSD-5", "int", "t-int")]);
    expect(s?.project.id).toBe("sd");
    expect(s?.task).toBeUndefined();
  });

  it("other prefixes follow the newest earlier ticket with that prefix, not fixed", () => {
    const s = suggestForTicket("MOS-77", projects, [entry("MOS-3", "mos", "t-dev"), entry("MOS-1", "int", "t-int")]);
    expect(s?.project.id).toBe("mos");
    expect(s?.fixed).toBe(false);
    expect(s?.task).toBeUndefined();
  });

  it("nothing known → no suggestion", () => {
    expect(suggestForTicket("ABC-1", projects, [entry("MOS-3", "mos", "t")])).toBeUndefined();
  });

  it("a prefix is not a substring match (CS ≠ CSD)", () => {
    expect(suggestForTicket("CS-1", projects, [entry("CSD-3", "sd", "t")])).toBeUndefined();
  });
});

describe("taskForOrganization: the customer task in Service Desk", () => {
  const tasks = [
    { id: "1", name: "Acme" },
    { id: "2", name: "Globex" },
    { id: "3", name: "Initech Groep" },
    { id: "4", name: "Phone call" },
    { id: "5", name: "Acme Energies" },
  ];
  it("exact name, ignoring case and legal form", () => {
    expect(taskForOrganization(["Globex B.V."], tasks)?.id).toBe("2");
    expect(taskForOrganization(["acme"], tasks)?.id).toBe("1");
  });
  it("one task containing the organisation (or the other way round)", () => {
    expect(taskForOrganization(["Initech"], tasks)?.id).toBe("3");
  });
  it("ambiguous or unknown → undefined, you pick", () => {
    expect(taskForOrganization(["Energies"], [...tasks, { id: "6", name: "Energies NL" }])).toBeUndefined();
    expect(taskForOrganization(["Unknown Corp"], tasks)).toBeUndefined();
    expect(taskForOrganization([], tasks)).toBeUndefined();
  });
  it("tries the next organisation when the first has no match", () => {
    expect(taskForOrganization(["Unknown", "Globex"], tasks)?.id).toBe("2");
  });
});
