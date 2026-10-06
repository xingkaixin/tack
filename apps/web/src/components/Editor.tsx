import { useEffect, useState, useSyncExternalStore } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import {
  Bold,
  Italic,
  Heading2,
  List,
  ListOrdered,
  Quote,
  Code,
  Undo2,
  Redo2,
  Cloud,
  CloudOff,
} from "lucide-react";
import { CollaborationProvider, acquireDocument } from "../lib/collaboration";
import { useI18n } from "../lib/i18n";
import type { User } from "../lib/types";
import { Button } from "./ui/button";

export function RichEditor({ issueId, user }: { issueId: string; user: User }) {
  const [provider, setProvider] = useState<CollaborationProvider>();
  useEffect(() => {
    const value = acquireDocument(issueId, user.id);
    void value.persistence.whenSynced.then(() => setProvider(value));
    return () => {
      setProvider(undefined);
      value.release();
    };
  }, [issueId, user.id]);
  return provider ? (
    <Editor provider={provider} user={user} />
  ) : (
    <div className="editor-skeleton" />
  );
}
function Editor({ provider, user }: { provider: CollaborationProvider; user: User }) {
  const { t } = useI18n();
  const status = useSyncExternalStore(provider.subscribe, provider.getStatus);
  const color = ["#25766b", "#526ba9", "#aa6656", "#9861a1"][user.id.charCodeAt(0) % 4];
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        Collaboration.configure({ document: provider.doc }),
        CollaborationCaret.configure({ provider, user: { name: user.name, color } }),
      ],
      editorProps: { attributes: { class: "rich-editor", "aria-label": t("description") } },
      immediatelyRender: false,
    },
    [provider],
  );
  const [, render] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const update = () => render((value) => value + 1);
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);
  if (!editor) return null;
  const actions = [
    {
      key: "bold",
      Icon: Bold,
      active: editor.isActive("bold"),
      run: () => editor.chain().focus().toggleBold().run(),
    },
    {
      key: "italic",
      Icon: Italic,
      active: editor.isActive("italic"),
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      key: "heading",
      Icon: Heading2,
      active: editor.isActive("heading"),
      run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      key: "bulletList",
      Icon: List,
      active: editor.isActive("bulletList"),
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      key: "orderedList",
      Icon: ListOrdered,
      active: editor.isActive("orderedList"),
      run: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      key: "quote",
      Icon: Quote,
      active: editor.isActive("blockquote"),
      run: () => editor.chain().focus().toggleBlockquote().run(),
    },
    {
      key: "code",
      Icon: Code,
      active: editor.isActive("codeBlock"),
      run: () => editor.chain().focus().toggleCodeBlock().run(),
    },
    { key: "undo", Icon: Undo2, active: false, run: () => editor.chain().focus().undo().run() },
    { key: "redo", Icon: Redo2, active: false, run: () => editor.chain().focus().redo().run() },
  ];
  return (
    <div className="editor-wrap">
      <div className="editor-toolbar">
        {actions.map(({ key, Icon, active, run }) => (
          <Button
            key={key}
            size="icon-sm"
            variant="ghost"
            title={t(key)}
            aria-label={t(key)}
            aria-pressed={active}
            onClick={run}
          >
            <Icon size={15} />
          </Button>
        ))}
      </div>
      <EditorContent editor={editor} />
      <div className="editor-status">
        {status === "editorSaved" ? <Cloud size={12} /> : <CloudOff size={12} />}
        <span>{t(status)}</span>
      </div>
    </div>
  );
}
