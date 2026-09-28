import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

function Hello({ name }: { name: string }) {
  return <p role="status">Hello, {name}</p>;
}

describe("frontend harness", () => {
  it("renders a React component under jsdom", () => {
    render(<Hello name="archer" />);
    expect(screen.getByRole("status").textContent).toBe("Hello, archer");
  });
});
