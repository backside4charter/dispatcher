import { describe, expect, it } from "vitest"
import { MemoryBoard, makeRow } from "../testing/board-fixtures"
import { assertLabelInUse, assertMayClose, isHumanAssigned } from "./policy"

describe("isHumanAssigned", () => {
  it("treats an assignee with no delegate as a human's row, which agents skip", () => {
    expect(isHumanAssigned(makeRow({ ref: "ACM-41", assignee: "someuser" }))).toBe(true)
  })

  it("treats a delegated row as agent-workable, even though delegating assigned it", () => {
    // Setting a delegate also sets the assignee to the acting account, so the
    // assignee alone would make every claimed row look like a human's.
    expect(isHumanAssigned(makeRow({
      ref: "ACM-12",
      assignee: "someuser",
      delegate: "acme-developer",
    }))).toBe(false)
  })

  it("treats an unassigned row as agent-workable", () => {
    expect(isHumanAssigned(makeRow({ ref: "ACM-12" }))).toBe(false)
  })
})

describe("the claim lifecycle keeps a row dispatchable", () => {
  it("leaves a released row unassigned, not stamped with the owner's name forever", async () => {
    const board = new MemoryBoard([{ ref: "ACM-12" }])
    expect(isHumanAssigned(await board.issue("ACM-12"))).toBe(false)

    await board.claim("ACM-12", "dev", "sess-1", new Date("2026-08-27T12:00:00Z"))
    const claimed = await board.issue("ACM-12")
    expect(claimed.delegate).toBe("acme-developer")
    expect(claimed.assignee).toBe("someuser")
    expect(isHumanAssigned(claimed)).toBe(false)

    await board.release("ACM-12")
    const released = await board.issue("ACM-12")
    // This is the whole reason release clears the assignee. Leave Linear's
    // residue behind and the row reads as human-owned, so the dispatcher would
    // never pick it up again - and every task an agent ever touched would be
    // permanently stuck.
    expect(released.delegate).toBeNull()
    expect(released.assignee).toBeNull()
    expect(isHumanAssigned(released)).toBe(false)
  })

  it("does not take a genuinely human-assigned row over when releasing an unheld one", async () => {
    const board = new MemoryBoard([{ ref: "ACM-41", assignee: "someuser" }])
    await board.release("ACM-41")
    const row = await board.issue("ACM-41")
    expect(row.assignee).toBe("someuser")
    expect(isHumanAssigned(row)).toBe(true)
  })
})

describe("assertLabelInUse", () => {
  it("refuses a label the workflow retired, naming what replaced it", () => {
    expect(() => assertLabelInUse("Question")).toThrow('refusing to write the "Question" label')
    expect(() => assertLabelInUse(" question ")).toThrow("board state <ref> question")
  })

  it("allows every label still in use", () => {
    expect(() => assertLabelInUse("UI")).not.toThrow()
    expect(() => assertLabelInUse("Confirm with user")).not.toThrow()
    expect(() => assertLabelInUse("Bug")).not.toThrow()
  })
})

describe("assertMayClose", () => {
  it("refuses to complete a top-level task, but allows a sub-issue", () => {
    expect(() => assertMayClose("ACM-12", "Done", true, false)).toThrow("only the owner's merge completes a top-level task")
    expect(() => assertMayClose("ACM-204", "Done", true, true)).not.toThrow()
    expect(() => assertMayClose("ACM-12", "In Progress", false, false)).not.toThrow()
  })
})
