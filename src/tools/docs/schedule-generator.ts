/**
 * Construction schedule generator tool for civilclaw.
 *
 * Generates a preliminary construction schedule with phases, milestones,
 * and critical path identification based on building type, size, and
 * construction method. Outputs a Gantt-like text representation or JSON.
 *
 * Pure TypeScript — no external dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface ScheduleTask {
  id: number;
  name: string;
  phase: string;
  duration_days: number;
  start_day: number;
  end_day: number;
  predecessors: number[];
  is_milestone: boolean;
  is_critical: boolean;
}

interface ScheduleResult {
  project_name: string;
  total_duration_days: number;
  total_duration_months: number;
  start_date: string;
  end_date: string;
  phases: { name: string; start_day: number; end_day: number; duration_days: number }[];
  tasks: ScheduleTask[];
  milestones: { name: string; day: number; date: string }[];
  notes: string[];
}

// ─── Phase templates ────────────────────────────────────────────────────────

interface PhaseTemplate {
  name: string;
  tasks: {
    name: string;
    base_duration_days: number;
    predecessors_relative: number[]; // relative to phase start index
    is_milestone?: boolean;
    size_factor?: number; // multiplier per 1000 sqm above base
  }[];
}

const PHASE_TEMPLATES: PhaseTemplate[] = [
  {
    name: "Pre-Construction",
    tasks: [
      { name: "Permitting & Approvals", base_duration_days: 45, predecessors_relative: [], size_factor: 0.1 },
      { name: "Bid & Award", base_duration_days: 30, predecessors_relative: [0] },
      { name: "Mobilization", base_duration_days: 14, predecessors_relative: [1] },
      { name: "Notice to Proceed", base_duration_days: 0, predecessors_relative: [2], is_milestone: true },
    ],
  },
  {
    name: "Site Work",
    tasks: [
      { name: "Site Clearing & Demolition", base_duration_days: 14, predecessors_relative: [], size_factor: 0.05 },
      { name: "Excavation & Grading", base_duration_days: 21, predecessors_relative: [0], size_factor: 0.08 },
      { name: "Underground Utilities", base_duration_days: 21, predecessors_relative: [1], size_factor: 0.05 },
    ],
  },
  {
    name: "Foundation",
    tasks: [
      { name: "Foundation Excavation", base_duration_days: 14, predecessors_relative: [], size_factor: 0.06 },
      { name: "Foundation Formwork & Rebar", base_duration_days: 21, predecessors_relative: [0], size_factor: 0.08 },
      { name: "Foundation Concrete Pour", base_duration_days: 7, predecessors_relative: [1] },
      { name: "Foundation Cure & Strip", base_duration_days: 14, predecessors_relative: [2] },
      { name: "Waterproofing & Backfill", base_duration_days: 10, predecessors_relative: [3] },
      { name: "Foundation Complete", base_duration_days: 0, predecessors_relative: [4], is_milestone: true },
    ],
  },
  {
    name: "Structure",
    tasks: [
      { name: "Structural Frame (per floor)", base_duration_days: 21, predecessors_relative: [], size_factor: 0.1 },
      { name: "Floor Decking & Slabs", base_duration_days: 14, predecessors_relative: [0], size_factor: 0.08 },
      { name: "Roof Structure", base_duration_days: 14, predecessors_relative: [1], size_factor: 0.05 },
      { name: "Structure Topped Out", base_duration_days: 0, predecessors_relative: [2], is_milestone: true },
    ],
  },
  {
    name: "Envelope",
    tasks: [
      { name: "Exterior Wall Framing / Panels", base_duration_days: 28, predecessors_relative: [], size_factor: 0.1 },
      { name: "Roofing & Waterproofing", base_duration_days: 21, predecessors_relative: [], size_factor: 0.05 },
      { name: "Windows & Glazing", base_duration_days: 21, predecessors_relative: [0], size_factor: 0.08 },
      { name: "Building Dried In", base_duration_days: 0, predecessors_relative: [1, 2], is_milestone: true },
    ],
  },
  {
    name: "MEP Rough-In",
    tasks: [
      { name: "Plumbing Rough-In", base_duration_days: 28, predecessors_relative: [], size_factor: 0.1 },
      { name: "HVAC Ductwork", base_duration_days: 35, predecessors_relative: [], size_factor: 0.12 },
      { name: "Electrical Rough-In", base_duration_days: 28, predecessors_relative: [], size_factor: 0.1 },
      { name: "Fire Protection Rough-In", base_duration_days: 21, predecessors_relative: [], size_factor: 0.05 },
    ],
  },
  {
    name: "Interior Finishes",
    tasks: [
      { name: "Interior Framing & Drywall", base_duration_days: 35, predecessors_relative: [], size_factor: 0.12 },
      { name: "Taping, Mudding & Painting", base_duration_days: 21, predecessors_relative: [0], size_factor: 0.08 },
      { name: "Flooring Installation", base_duration_days: 21, predecessors_relative: [1], size_factor: 0.08 },
      { name: "Ceiling Installation", base_duration_days: 14, predecessors_relative: [1], size_factor: 0.05 },
      { name: "Millwork & Cabinetry", base_duration_days: 14, predecessors_relative: [2], size_factor: 0.05 },
      { name: "Specialties & Accessories", base_duration_days: 7, predecessors_relative: [2, 3] },
    ],
  },
  {
    name: "MEP Finishes",
    tasks: [
      { name: "Plumbing Fixtures", base_duration_days: 14, predecessors_relative: [], size_factor: 0.05 },
      { name: "HVAC Equipment & Startup", base_duration_days: 21, predecessors_relative: [], size_factor: 0.08 },
      { name: "Electrical Devices & Fixtures", base_duration_days: 14, predecessors_relative: [], size_factor: 0.05 },
      { name: "Fire Alarm & Life Safety", base_duration_days: 14, predecessors_relative: [], size_factor: 0.03 },
    ],
  },
  {
    name: "Closeout",
    tasks: [
      { name: "Punch List", base_duration_days: 21, predecessors_relative: [], size_factor: 0.05 },
      { name: "Final Inspections", base_duration_days: 14, predecessors_relative: [0] },
      { name: "Commissioning", base_duration_days: 14, predecessors_relative: [0] },
      { name: "Certificate of Occupancy", base_duration_days: 0, predecessors_relative: [1, 2], is_milestone: true },
      { name: "Owner Training & Turnover", base_duration_days: 7, predecessors_relative: [3] },
      { name: "Substantial Completion", base_duration_days: 0, predecessors_relative: [4], is_milestone: true },
    ],
  },
];

// Story multiplier for structural phase
const STORY_FACTORS: Record<number, number> = {
  1: 1.0,
  2: 1.5,
  3: 1.8,
  4: 2.1,
  5: 2.4,
};

function getStoryFactor(stories: number): number {
  if (stories <= 5) return STORY_FACTORS[stories] ?? 1.0;
  return 2.4 + (stories - 5) * 0.25;
}

// ─── Schedule generation ────────────────────────────────────────────────────

function generateSchedule(params: {
  project_name: string;
  gross_area_sqm: number;
  stories?: number;
  start_date?: string;
  building_type?: string;
}): ScheduleResult {
  const projectName = params.project_name;
  const grossArea = params.gross_area_sqm;
  const stories = params.stories ?? 1;
  const storyFactor = getStoryFactor(stories);
  const startDateStr = params.start_date ?? new Date().toISOString().split("T")[0]!;
  const startDate = new Date(startDateStr);

  // Size adjustment: base is 500 sqm, additional time per 1000 sqm
  const sizeExtra = Math.max(0, (grossArea - 500) / 1000);

  const allTasks: ScheduleTask[] = [];
  const phaseResults: ScheduleResult["phases"] = [];
  let globalId = 1;
  let previousPhaseLastDay = 0;

  for (const phase of PHASE_TEMPLATES) {
    const phaseStartId = globalId;
    const taskMap = new Map<number, ScheduleTask>(); // relative index -> task

    for (let i = 0; i < phase.tasks.length; i++) {
      const tmpl = phase.tasks[i]!;

      // Compute duration with size/story adjustments
      let duration = tmpl.base_duration_days;
      if (tmpl.size_factor) {
        duration += Math.round(sizeExtra * tmpl.size_factor * tmpl.base_duration_days);
      }
      // Apply story factor to structural-related phases
      if (phase.name === "Structure") {
        duration = Math.round(duration * storyFactor);
      }
      if (tmpl.is_milestone) duration = 0;

      // Resolve predecessors (global ids)
      const predecessors: number[] = [];
      for (const relIdx of tmpl.predecessors_relative) {
        const pred = taskMap.get(relIdx);
        if (pred) predecessors.push(pred.id);
      }
      // If no predecessors within phase, depend on last task of previous phase
      if (predecessors.length === 0 && previousPhaseLastDay > 0 && i === 0) {
        // Depend on the end of the previous phase — use start_day = previousPhaseLastDay
      }

      // Calculate start day
      let startDay: number;
      if (predecessors.length === 0) {
        startDay = previousPhaseLastDay;
      } else {
        startDay = 0;
        for (const predId of predecessors) {
          const pred = allTasks.find((t) => t.id === predId);
          if (pred && pred.end_day > startDay) startDay = pred.end_day;
        }
      }

      const task: ScheduleTask = {
        id: globalId,
        name: tmpl.name,
        phase: phase.name,
        duration_days: duration,
        start_day: startDay,
        end_day: startDay + duration,
        predecessors,
        is_milestone: tmpl.is_milestone ?? false,
        is_critical: false, // Will be computed later
      };

      taskMap.set(i, task);
      allTasks.push(task);
      globalId++;
    }

    // Determine phase bounds
    const phaseTasks = allTasks.filter((t) => t.phase === phase.name);
    const phaseStart = Math.min(...phaseTasks.map((t) => t.start_day));
    const phaseEnd = Math.max(...phaseTasks.map((t) => t.end_day));
    phaseResults.push({
      name: phase.name,
      start_day: phaseStart,
      end_day: phaseEnd,
      duration_days: phaseEnd - phaseStart,
    });

    previousPhaseLastDay = phaseEnd;
  }

  // Simple critical path: find longest path through the schedule
  const totalDuration = Math.max(...allTasks.map((t) => t.end_day));
  markCriticalPath(allTasks, totalDuration);

  // Compute dates
  const milestones = allTasks
    .filter((t) => t.is_milestone)
    .map((t) => {
      const date = new Date(startDate);
      date.setDate(date.getDate() + t.start_day);
      return {
        name: t.name,
        day: t.start_day,
        date: date.toISOString().split("T")[0]!,
      };
    });

  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + totalDuration);

  return {
    project_name: projectName,
    total_duration_days: totalDuration,
    total_duration_months: Math.round((totalDuration / 30) * 10) / 10,
    start_date: startDateStr,
    end_date: endDate.toISOString().split("T")[0]!,
    phases: phaseResults,
    tasks: allTasks,
    milestones,
    notes: [
      "This is a preliminary schedule estimate. Actual durations vary based on site conditions, labor availability, and weather.",
      "Schedule assumes sequential construction phases with standard overlap opportunities.",
      `Adjusted for building size (${grossArea} sqm) and height (${stories} stories).`,
    ],
  };
}

function markCriticalPath(tasks: ScheduleTask[], totalDuration: number) {
  // Backward pass: mark tasks that are on the longest path
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // Find tasks with no successors
  const hasSuccessor = new Set<number>();
  for (const t of tasks) {
    for (const predId of t.predecessors) {
      hasSuccessor.add(predId);
    }
  }

  // Mark critical from end
  const criticalSet = new Set<number>();
  const queue = tasks.filter((t) => !hasSuccessor.has(t.id) && t.end_day === totalDuration);
  for (const t of queue) criticalSet.add(t.id);

  // Trace back through predecessors
  const visited = new Set<number>();
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);

    for (const predId of current.predecessors) {
      const pred = taskById.get(predId);
      if (pred && pred.end_day === current.start_day) {
        criticalSet.add(pred.id);
        queue.push(pred);
      }
    }
  }

  for (const t of tasks) {
    t.is_critical = criticalSet.has(t.id);
  }
}

// ─── Text formatting ────────────────────────────────────────────────────────

function formatScheduleText(result: ScheduleResult): string {
  const lines: string[] = [
    "PRELIMINARY CONSTRUCTION SCHEDULE",
    `Project: ${result.project_name}`,
    `Duration: ${result.total_duration_days} days (${result.total_duration_months} months)`,
    `Start: ${result.start_date}  |  End: ${result.end_date}`,
    "=".repeat(90),
    "",
  ];

  // Phases summary
  lines.push("PHASE SUMMARY");
  lines.push("-".repeat(90));
  lines.push(
    padRight("Phase", 30) + padRight("Start", 12) + padRight("End", 12) + padRight("Duration", 12),
  );
  lines.push("-".repeat(90));
  for (const phase of result.phases) {
    lines.push(
      padRight(phase.name, 30) +
      padRight(`Day ${phase.start_day}`, 12) +
      padRight(`Day ${phase.end_day}`, 12) +
      padRight(`${phase.duration_days}d`, 12),
    );
  }
  lines.push("");

  // Milestones
  lines.push("KEY MILESTONES");
  lines.push("-".repeat(90));
  for (const m of result.milestones) {
    lines.push(`  ${m.date}  (Day ${m.day})  ${m.name}`);
  }
  lines.push("");

  // Detailed task list
  lines.push("DETAILED TASK LIST");
  lines.push("-".repeat(90));
  lines.push(
    padRight("ID", 5) +
    padRight("Task", 38) +
    padRight("Duration", 10) +
    padRight("Start", 10) +
    padRight("End", 10) +
    padRight("Crit", 6) +
    "Predecessors",
  );
  lines.push("-".repeat(90));

  let currentPhase = "";
  for (const task of result.tasks) {
    if (task.phase !== currentPhase) {
      currentPhase = task.phase;
      lines.push(`\n  ── ${currentPhase} ──`);
    }

    const marker = task.is_milestone ? " ◆" : task.is_critical ? " *" : "  ";
    lines.push(
      padRight(`${task.id}`, 5) +
      padRight(`${marker}${task.name}`, 38) +
      padRight(task.is_milestone ? "---" : `${task.duration_days}d`, 10) +
      padRight(`Day ${task.start_day}`, 10) +
      padRight(`Day ${task.end_day}`, 10) +
      padRight(task.is_critical ? "YES" : "", 6) +
      (task.predecessors.length > 0 ? task.predecessors.join(", ") : "-"),
    );
  }

  lines.push("");
  lines.push("* = Critical path task  |  ◆ = Milestone");
  lines.push("");
  lines.push("NOTES:");
  for (const note of result.notes) {
    lines.push(`- ${note}`);
  }

  return lines.join("\n");
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

// ─── Tool definition ────────────────────────────────────────────────────────

export function createScheduleGeneratorToolDefinition() {
  return {
    name: "schedule_generator",
    label: "Schedule Generator",
    description:
      "Generate a preliminary construction schedule with phases, task durations, milestones, and critical path identification.",
    parameters: {
      type: "object",
      properties: {
        project_name: {
          type: "string",
          description: "Name of the project.",
        },
        gross_area_sqm: {
          type: "number",
          description: "Total gross building area in square meters. Affects task durations.",
          minimum: 1,
        },
        stories: {
          type: "number",
          description: "Number of stories. Increases structural phase duration. Default: 1.",
          minimum: 1,
          default: 1,
        },
        start_date: {
          type: "string",
          description: 'Project start date in YYYY-MM-DD format. Default: today.',
        },
        building_type: {
          type: "string",
          enum: ["residential", "commercial", "industrial", "institutional", "healthcare"],
          description: 'Building type for schedule template. Default: "commercial".',
          default: "commercial",
        },
        output_format: {
          type: "string",
          enum: ["text", "json"],
          description: 'Output format. Default: "text".',
          default: "text",
        },
      },
      required: ["project_name", "gross_area_sqm"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      const projectName = String(params.project_name ?? "Untitled Project").trim();
      const grossArea = Number(params.gross_area_sqm);
      if (!grossArea || grossArea <= 0) {
        throw new Error("gross_area_sqm must be a positive number.");
      }

      const stories = params.stories !== undefined ? Math.max(1, Math.round(Number(params.stories))) : undefined;
      const startDate = typeof params.start_date === "string" ? params.start_date.trim() : undefined;
      const buildingType = typeof params.building_type === "string" ? params.building_type.trim() : undefined;
      const outputFormat = typeof params.output_format === "string" ? params.output_format : "text";

      const result = generateSchedule({
        project_name: projectName,
        gross_area_sqm: grossArea,
        stories,
        start_date: startDate,
        building_type: buildingType,
      });

      const text = outputFormat === "json"
        ? JSON.stringify(result, null, 2)
        : formatScheduleText(result);

      return {
        content: [{ type: "text", text }],
        details: {
          project_name: result.project_name,
          total_duration_days: result.total_duration_days,
          total_duration_months: result.total_duration_months,
          milestone_count: result.milestones.length,
          task_count: result.tasks.length,
        },
      };
    },
  };
}
