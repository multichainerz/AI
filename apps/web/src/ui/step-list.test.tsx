/**
 * @vitest-environment jsdom
 */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StepList, type StepListItem } from "./step-list.js";

const items: StepListItem[] = [
  { key: "a", ordinal: 1, title: "One", status: "done" },
  { key: "b", ordinal: 2, title: "Two", status: "current" },
  { key: "c", ordinal: 3, title: "Three", status: "blocked" },
];

describe("StepList", () => {
  it("does not draw a horizontal rule through the step cells", () => {
    const { container } = render(
      <StepList label="Steps" items={items} activeKey="b" onSelect={vi.fn()} orientation="horizontal" />,
    );
    // The rotated spine sat at the marker midline and crossed every title.
    expect(container.querySelector("ol")?.querySelectorAll(".h-px")).toHaveLength(0);
  });

  it("still joins a vertical rail between stacked markers", () => {
    const { container } = render(
      <StepList label="Steps" items={items} activeKey="b" onSelect={vi.fn()} />,
    );
    expect(container.querySelectorAll("ol .w-px")).toHaveLength(2);
  });
});
