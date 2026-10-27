import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const COLORS = HighlightStyle.define([
  { tag: [t.tagName, t.angleBracket], color: "var(--color-code-tag)" },
  { tag: [t.attributeName, t.propertyName], color: "var(--color-code-attribute)" },
  { tag: [t.string, t.attributeValue], color: "var(--color-code-string)" },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: "var(--color-code-keyword)" },
  { tag: [t.number, t.bool, t.null, t.unit, t.color], color: "var(--color-code-number)" },
  { tag: [t.comment, t.blockComment, t.lineComment], color: "var(--color-code-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.className, t.labelName], color: "var(--color-code-function)" },
]);

const THEME = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "var(--color-well)", color: "var(--color-text-strong)", borderRadius: "6px", border: "1px solid var(--color-field-edge)" },
    "&.cm-focused": { outline: "none", borderColor: "var(--color-accent)" },
    ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px", lineHeight: "1.6" },
    ".cm-gutters": { backgroundColor: "transparent", color: "var(--color-text-faint)", border: "none" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--color-item-hover)" },
    ".cm-matchingBracket": { backgroundColor: "var(--color-accent-wash)", outline: "1px solid var(--color-accent)" },
    ".cm-selectionMatch, .cm-searchMatch": { backgroundColor: "var(--color-accent-wash)" },
    ".cm-cursor": { borderLeftColor: "var(--color-text-strong)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--color-accent-wash)" },
    ".cm-panels": { backgroundColor: "var(--color-panel)", color: "var(--color-text)", borderColor: "var(--color-divider)" },
  },
  { dark: true },
);

/**
 * HTML (with its CSS and script) in a code editor: coloured, line numbers, matching brackets, ⌘F to find, Tab
 * indents. `onSave`: ⌘S. Controlled loosely: `value` is read when it changes from outside, not on every keystroke.
 */
export function CodeEditor({ value, onChange, onSave, wrap = false, className, ...data }: { value: string; onChange: (text: string) => void; onSave?: () => void; wrap?: boolean; className?: string; [data: `data-${string}`]: unknown }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const wrapping = useRef(new Compartment());
  const latest = useRef({ onChange, onSave });
  latest.current = { onChange, onSave };
  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          wrapping.current.of(wrap ? EditorView.lineWrapping : []),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          html(),
          syntaxHighlighting(COLORS),
          THEME,
          keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (latest.current.onSave?.(), true) }, ...searchKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
          EditorView.updateListener.of((u) => u.docChanged && latest.current.onChange(u.state.doc.toString())),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, []);
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);
  return <div ref={host} className={className} {...data} />;
}
