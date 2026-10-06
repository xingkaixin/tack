import { useCallback, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  pointerWithin,
  rectIntersection,
  type DragMoveEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { generateKeyBetween } from "fractional-indexing";
import { GripVertical, Plus, CalendarDays } from "lucide-react";
import { statuses, type Issue, type Member, type Fields } from "../lib/types";
import { enqueue } from "../lib/store";
import { useI18n } from "../lib/i18n";
import { Avatar, StatusDot } from "./IssueDetail";
import { PriorityIcon } from "./IssueList";
import { Button } from "./ui/button";

type Status = Fields["status"];
type Placement = { status: Status; before: string | null };
function boardRank(issue: Issue) {
  // Legacy issues get a stable fractional key without rewriting existing records.
  return (
    issue.fields.board_rank ||
    `a0${issue.created_at.replace(/\D/g, "")}${issue.id.replaceAll("-", "")}V`
  );
}
function rankBetween(left: string, right: string) {
  let rank = generateKeyBetween(left, right);
  while (right.startsWith(rank)) rank = generateKeyBetween(left, rank);
  // Distinct clients can drop into the same gap while offline; keep their keys distinct.
  return `${rank}${crypto.randomUUID().replaceAll("-", "")}V`;
}
function compareIssues(a: Issue, b: Issue) {
  const left = boardRank(a),
    right = boardRank(b);
  return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
}
const keyboardCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  const { droppableContainers, droppableRects } = context;
  const columns = droppableContainers
    .getEnabled()
    .filter((item) => item.data.current?.kind === "column");
  const index = columns.findIndex((item) => {
    const rect = droppableRects.get(item.id);
    return rect && currentCoordinates.x >= rect.left && currentCoordinates.x <= rect.right;
  });
  if (index < 0) return;
  if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
    const target = columns[index + (event.code === "ArrowRight" ? 1 : -1)];
    const rect = target && droppableRects.get(target.id);
    if (rect) return { x: rect.left + 24, y: rect.top + 64 };
  }
  if (event.code === "ArrowDown" || event.code === "ArrowUp") {
    const down = event.code === "ArrowDown";
    const cards = droppableContainers
      .getEnabled()
      .filter(
        (item) =>
          item.data.current?.kind === "card" &&
          item.data.current.status === columns[index].id &&
          item.id !== context.active?.id,
      )
      .map((item) => droppableRects.get(item.id)!)
      .filter(Boolean)
      .sort((a, b) => a.top - b.top);
    const points = cards.map((rect) => (down ? rect.bottom + 4 : rect.top - 4));
    const y = down
      ? points.find((point) => point > currentCoordinates.y + 4)
      : points.findLast((point) => point < currentCoordinates.y - 4);
    if (y !== undefined) return { x: currentCoordinates.x, y };
  }
};

function CardContent({ issue, members }: { issue: Issue; members: Member[] }) {
  const { t } = useI18n();
  const member = members.find((member) => member.id === issue.fields.assignee);
  return (
    <>
      <div className="card-heading">
        <span className="issue-id">{issue.identifier}</span>
        <StatusDot status={issue.fields.status} />
      </div>
      <h4>{issue.fields.title}</h4>
      {issue.fields.labels.length > 0 && (
        <div className="card-labels">
          {issue.fields.labels.map((label) => (
            <span key={label} className="label-chip">
              {label}
            </span>
          ))}
        </div>
      )}
      <div className="card-bottom">
        <span className="card-priority" title={t(issue.fields.priority)}>
          <PriorityIcon priority={issue.fields.priority} />
          <span>{t(issue.fields.priority)}</span>
        </span>
        {issue.fields.due_date && (
          <span className="card-date">
            <CalendarDays size={12} />
            {issue.fields.due_date.slice(5)}
          </span>
        )}
        <span className="spacer" />
        {member && <Avatar name={member.name} small />}
      </div>
    </>
  );
}
function BoardCard({
  issue,
  members,
  onSelect,
  before,
}: {
  issue: Issue;
  members: Member[];
  onSelect: () => void;
  before: boolean;
}) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: issue.id,
  });
  const { setNodeRef: setDropRef } = useDroppable({
    id: issue.id,
    data: { kind: "card", status: issue.fields.status },
  });
  const setCardRef = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);
      setDropRef(node);
    },
    [setNodeRef, setDropRef],
  );
  return (
    <div className={`board-card-slot ${before ? "drop-before" : ""}`}>
      <article
        ref={setCardRef}
        className={`issue-card ${isDragging ? "is-dragging" : ""}`}
        data-issue-id={issue.id}
      >
        <button
          className="card-open"
          onMouseDown={(event) => listeners?.onMouseDown?.(event)}
          onTouchStart={(event) => listeners?.onTouchStart?.(event)}
          onClick={onSelect}
          aria-label={`${issue.identifier} ${issue.fields.title}`}
        >
          <CardContent issue={issue} members={members} />
        </button>
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          className="card-drag-handle"
          aria-label={`${t("dragIssue")} ${issue.identifier}`}
        >
          <GripVertical size={15} />
        </button>
      </article>
    </div>
  );
}
function BoardColumn({
  status,
  children,
  count,
  active,
  tail,
  onCreate,
}: {
  status: Status;
  children: ReactNode;
  count: number;
  active: boolean;
  tail: boolean;
  onCreate: () => void;
}) {
  const { t } = useI18n();
  const { setNodeRef } = useDroppable({ id: status, data: { kind: "column", status } });
  return (
    <section
      ref={setNodeRef}
      className={`board-column ${active ? "is-drop-target" : ""}`}
      data-status={status}
      aria-label={t(status)}
    >
      <header className="board-heading">
        <StatusDot status={status} />
        <h3>{t(status)}</h3>
        <span className="count">{count}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onCreate}
          aria-label={`${t("newIssue")} · ${t(status)}`}
        >
          <Plus size={15} />
        </Button>
      </header>
      <div className="board-cards">
        {children}
        {tail && <div className="board-drop-tail" aria-hidden />}
        {count === 0 && !tail && (
          <div className="board-empty">
            <span>{t("emptyColumn")}</span>
            <Button variant="ghost" size="sm" onClick={onCreate}>
              <Plus size={14} />
              {t("newIssue")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
export function IssueBoard({
  issues,
  members,
  onSelect,
  onCreate,
}: {
  issues: Issue[];
  members: Member[];
  onSelect: (id: string) => void;
  onCreate: (status?: Status) => void;
}) {
  const { t } = useI18n();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [error, setError] = useState("");
  const active = issues.find((issue) => issue.id === activeId);
  const sorted = [...issues].sort(compareIssues);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  );
  const locate = (event: DragMoveEvent) => {
    const status = event.over?.data.current?.status as Status | undefined;
    if (!status) {
      setPlacement(null);
      return;
    }
    const rect = event.active.rect.current.translated;
    if (!rect) return;
    const card =
      event.over?.data.current?.kind === "card"
        ? issues.find((issue) => issue.id === event.over?.id)
        : undefined;
    const column = sorted.filter(
      (issue) => issue.fields.status === status && issue.id !== event.active.id,
    );
    let before: string | null = null;
    if (card && card.id !== event.active.id) {
      const index = column.findIndex((issue) => issue.id === card.id);
      const below = rect.top + rect.height / 2 > event.over!.rect.top + event.over!.rect.height / 2;
      before = column[index + (below ? 1 : 0)]?.id || null;
    } else if (card?.id === event.active.id) {
      const siblings = sorted.filter((issue) => issue.fields.status === status);
      before =
        siblings[siblings.findIndex((issue) => issue.id === event.active.id) + 1]?.id || null;
    } else if (rect.top < event.over!.rect.top + 80) before = column[0]?.id || null;
    setPlacement((current) =>
      current?.status === status && current.before === before ? current : { status, before },
    );
  };
  const finish = () => {
    setActiveId(null);
    setPlacement(null);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) => {
        const collisions = pointerWithin(args);
        return collisions.length
          ? [
              collisions.find(
                (item) => item.data?.droppableContainer.data.current?.kind === "card",
              ) || collisions[0],
            ]
          : rectIntersection(args);
      }}
      onDragStart={({ active }) => {
        setActiveId(String(active.id));
        setError("");
      }}
      onDragMove={locate}
      onDragOver={locate}
      onDragCancel={finish}
      onDragEnd={() => {
        if (active && placement) {
          const column = sorted.filter(
            (issue) => issue.fields.status === placement.status && issue.id !== active.id,
          );
          const index = placement.before
            ? column.findIndex((issue) => issue.id === placement.before)
            : column.length;
          const rank = rankBetween(
            index > 0 ? boardRank(column[index - 1]) : "a0",
            index < column.length ? boardRank(column[index]) : "a1",
          );
          void enqueue(
            "issue.patch",
            { id: active.id, fields: { status: placement.status, board_rank: rank } },
            { status: active.fields.status, board_rank: active.fields.board_rank ?? null },
          ).catch(() => setError("server_error"));
        }
        finish();
      }}
      accessibility={{
        screenReaderInstructions: { draggable: t("boardDragHelp") },
        announcements: {
          onDragStart: ({ active }) =>
            `${t("boardMoving")} ${issues.find((issue) => issue.id === active.id)?.identifier || ""}`,
          onDragOver: ({ over }) =>
            over
              ? `${t("boardTarget")} ${t(String(over.data.current?.status))}`
              : t("boardOutside"),
          onDragEnd: () => t("boardDropped"),
          onDragCancel: () => t("boardCancelled"),
        },
      }}
    >
      {error && (
        <p className="notice error" role="alert">
          {t(error)}
        </p>
      )}
      <div className="board">
        {statuses.map((status) => {
          const column = sorted.filter((issue) => issue.fields.status === status);
          return (
            <BoardColumn
              key={status}
              status={status}
              count={column.length}
              active={placement?.status === status}
              tail={placement?.status === status && placement.before === null}
              onCreate={() => onCreate(status)}
            >
              {column.map((issue) => (
                <BoardCard
                  key={issue.id}
                  issue={issue}
                  members={members}
                  before={placement?.status === status && placement.before === issue.id}
                  onSelect={() => {
                    onSelect(issue.id);
                  }}
                />
              ))}
            </BoardColumn>
          );
        })}
      </div>
      {createPortal(
        <DragOverlay dropAnimation={null}>
          {active && (
            <div className="issue-card card-overlay">
              <CardContent issue={active} members={members} />
            </div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}
