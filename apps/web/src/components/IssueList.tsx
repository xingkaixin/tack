import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { Plus, Inbox, SignalHigh, SignalMedium, SignalLow, Minus, AlertCircle } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { IssueBoard } from "./IssueBoard";
import { type Fields, type Issue, type Member } from "../lib/types";
import { StatusDot, Avatar } from "./IssueDetail";
import { Button } from "./ui/button";
export function PriorityIcon({ priority }: { priority: string }) {
  const Icon =
    (
      { high: SignalHigh, medium: SignalMedium, low: SignalLow, urgent: AlertCircle } as Record<
        string,
        typeof Minus
      >
    )[priority] || Minus;
  return <Icon size={15} className={`priority-${priority}`} />;
}
export function IssueList({
  issues,
  members,
  view,
  onSelect,
  onCreate,
}: {
  issues: Issue[];
  members: Member[];
  view: string;
  onSelect: (id: string) => void;
  onCreate: (status?: Fields["status"]) => void;
}) {
  const { t, locale } = useI18n();
  const columns = useMemo<ColumnDef<Issue>[]>(
    () => [
      {
        id: "identifier",
        header: "ID",
        cell: ({ row }) => <span className="issue-id">{row.original.identifier}</span>,
      },
      {
        id: "title",
        header: t("title"),
        cell: ({ row }) => (
          <div className="table-title">
            <StatusDot status={row.original.fields.status} />
            <span>{row.original.fields.title}</span>
            {row.original.fields.labels.slice(0, 2).map((label) => (
              <span className="label-chip" key={label}>
                {label}
              </span>
            ))}
          </div>
        ),
      },
      {
        id: "priority",
        header: t("priority"),
        cell: ({ row }) => (
          <span className="priority-cell">
            <PriorityIcon priority={row.original.fields.priority} />
            {t(row.original.fields.priority)}
          </span>
        ),
      },
      {
        id: "assignee",
        header: t("assignee"),
        cell: ({ row }) => {
          const member = members.find((m) => m.id === row.original.fields.assignee);
          return member ? (
            <span className="assignee-cell">
              <Avatar name={member.name} small />
              {member.name}
            </span>
          ) : (
            <span className="muted">—</span>
          );
        },
      },
      {
        id: "due",
        header: t("due_date"),
        cell: ({ row }) => {
          const date = row.original.fields.due_date;
          return (
            <span
              className={
                date &&
                date < new Date().toLocaleDateString("en-CA") &&
                row.original.fields.status !== "done"
                  ? "overdue"
                  : "muted"
              }
            >
              {date
                ? new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
                    month: "short",
                    day: "numeric",
                  }).format(new Date(`${date}T12:00:00`))
                : "—"}
            </span>
          );
        },
      },
    ],
    [t, locale, members],
  );
  const table = useReactTable({ data: issues, columns, getCoreRowModel: getCoreRowModel() });
  if (view === "board")
    return <IssueBoard issues={issues} members={members} onSelect={onSelect} onCreate={onCreate} />;
  if (!issues.length)
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <Inbox size={27} />
        </div>
        <h2>{t("empty")}</h2>
        <p>{t("emptyHint")}</p>
        <Button onClick={() => onCreate()}>
          <Plus size={15} />
          {t("newIssue")}
        </Button>
      </div>
    );
  return (
    <div className="issue-table-wrap">
      <table className="issue-table">
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th key={header.id}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.original.id}
              tabIndex={0}
              aria-label={`${row.original.identifier} ${row.original.fields.title}`}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSelect(row.original.id);
              }}
              onClick={() => onSelect(row.original.id)}
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
